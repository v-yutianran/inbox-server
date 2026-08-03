import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  executeLegacyRehearsal,
  LegacyRehearsalError,
  runD1CompatibilityCheck,
  writeLegacyRehearsalEvidence,
} from "../src/legacy-rehearsal-executor";
import {
  buildLegacyRehearsalPlan,
  parseLegacyRehearsalManifest,
} from "../src/legacy-rehearsal-plan";
import type { CommandRunner } from "../src/release-executor";

const sha256 = "a".repeat(64);
const digest = (name: string) =>
  `ghcr.nju.edu.cn/v-yutianran/${name}@sha256:${sha256}`;

function manifest() {
  return {
    assets: {
      channelsPath: "deploy/rehearsal/synthetic-channels.yml",
      composePath: "deploy/rehearsal/compose.yml",
      postgresSeedPath: "deploy/rehearsal/postgres-seed.sql",
    },
    backup: {
      id: "synthetic-postgres-v1",
      sha256,
    },
    cloudflare: {
      apiPreviousVersion: "11111111-1111-4111-8111-111111111111",
      consolePreviousCommit: "1".repeat(40),
    },
    d1: {
      legacyCutoff: "apps/api/migrations/0004_article_retry_safety.sql",
      migrations: [
        "apps/api/migrations/0001_initial.sql",
        "apps/api/migrations/0002_worker_runtime.sql",
        "apps/api/migrations/0003_queue_inbox.sql",
        "apps/api/migrations/0004_article_retry_safety.sql",
        "apps/api/migrations/0005_operations_readiness.sql",
        "apps/api/migrations/0006_operations_metrics.sql",
        "apps/api/migrations/0007_operations_baselines.sql",
      ],
    },
    images: {
      mihomo: digest("mihomo"),
      warp: digest("warp"),
      worker: digest("worker"),
    },
    rtoSeconds: 900,
    runId: "rb-20300101-000001",
    schemaVersion: 1,
    sourceCommit: "2".repeat(40),
  };
}

describe("legacy rollback rehearsal", () => {
  it("固定 manifest 生成稳定 planHash，计划中不存在生产命令", () => {
    const parsed = parseLegacyRehearsalManifest(manifest());
    const first = buildLegacyRehearsalPlan(parsed);
    const second = buildLegacyRehearsalPlan(parsed);
    const commands = first.steps.flatMap(({ commands }) => commands)
      .map(({ args, file }) => [file, ...args].join(" "));

    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.planHash).toBe(second.planHash);
    expect(first.projectName).toBe("inbox-rollback-rb-20300101-000001");
    expect(first.steps.map(({ id }) => id)).toEqual([
      "isolation-preflight",
      "identity-evidence",
      "d1-compatibility",
      "substitute-worker-stop",
      "legacy-compose-restore",
      "reconciliation",
    ]);
    expect(commands.some((value) => /wrangler|kubectl|https?:\/\//i.test(value))).toBe(false);
  });

  it.each([
    ["生产 context", { context: "sealos-bja-ns-tbs948af" }],
    ["Secret", { secret: "raw-value" }],
    ["远程数据库", { databaseUrl: "https://example.invalid/db" }],
    ["任意命令", { command: "kubectl delete pod" }],
  ])("拒绝 manifest 中的%s字段", (_label, extra) => {
    expect(() => parseLegacyRehearsalManifest({ ...manifest(), ...extra })).toThrow(
      /未允许字段/,
    );
  });

  it("dry-run 与实际计划共用 planHash 且完全不调用执行器", async () => {
    const runner = vi.fn<CommandRunner>();
    const d1Check = vi.fn();
    const plan = buildLegacyRehearsalPlan(parseLegacyRehearsalManifest(manifest()));

    const evidence = await executeLegacyRehearsal(plan, {
      d1Check,
      dryRun: true,
      runner,
    });

    expect(evidence.planHash).toBe(plan.planHash);
    expect(evidence.steps.every(({ status }) => status === "planned")).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(d1Check).not.toHaveBeenCalled();
  });

  it("中途失败后仍执行 cleanup 并记录稳定失败事件", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      const rendered = [command.file, ...command.args].join(" ");
      calls.push(rendered);
      if (rendered.includes("ps --format json")) {
        return { exitCode: 1, stderr: "token=synthetic-secret", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const plan = buildLegacyRehearsalPlan(parseLegacyRehearsalManifest(manifest()));

    const failure = await executeLegacyRehearsal(plan, {
      confirm: plan.planHash,
      d1Check: vi.fn().mockResolvedValue({
        legacyWriteCount: 1,
        migrationCount: 7,
        stableDigest: sha256,
      }),
      dryRun: false,
      identityCheck: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      runner,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LegacyRehearsalError);
    expect(calls.some((value) => value.includes("down --volumes --remove-orphans"))).toBe(true);
    expect((failure as LegacyRehearsalError).evidence.steps.at(-2)).toMatchObject({
      event: "operations.rollback_rehearsal.step_failed",
      resultSummary: expect.not.stringContaining("synthetic-secret"),
      status: "failed",
    });
    expect((failure as LegacyRehearsalError).evidence.residuals).toEqual({
      containers: 0,
      networks: 0,
      tempFiles: 0,
      volumes: 0,
    });
  });

  it("允许容器内部 exposed port，但不把 PublishedPort=0 误判为宿主发布", async () => {
    const services = ["postgres", "redis", "server", "worker"].map((Service) => ({
      Health: "healthy",
      Publishers: [{ PublishedPort: 0, TargetPort: Service === "postgres" ? 5432 : 8000 }],
      Service,
      State: "running",
    }));
    const runner: CommandRunner = async (command) => {
      const rendered = [command.file, ...command.args].join(" ");
      if (rendered.includes("ps --format json")) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(services) };
      }
      if (rendered.includes("rehearsal_backup_marker")) {
        return { exitCode: 0, stderr: "", stdout: "synthetic-postgres-v1|1\n" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const plan = buildLegacyRehearsalPlan(parseLegacyRehearsalManifest(manifest()));

    const result = await executeLegacyRehearsal(plan, {
      confirm: plan.planHash,
      d1Check: vi.fn().mockResolvedValue({
        legacyWriteCount: 1,
        migrationCount: 7,
        stableDigest: sha256,
      }),
      dryRun: false,
      identityCheck: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      runner,
    });

    expect(result.event).toBe("operations.rollback_rehearsal.completed");
    expect(result.residuals).toEqual({ containers: 0, networks: 0, tempFiles: 0, volumes: 0 });
  });

  it("本地 D1 在旧契约写入后应用最新 migration 仍可读取并幂等重放", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "inbox-d1-rehearsal-test-"));
    try {
      const parsed = parseLegacyRehearsalManifest(manifest());
      const result = await runD1CompatibilityCheck(parsed, {
        repositoryRoot: resolve(process.cwd(), "../.."),
        tempRoot,
      });

      expect(result.migrationCount).toBe(7);
      expect(result.legacyWriteCount).toBe(1);
      expect(result.stableDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("证据路径父目录不存在时自动创建且拒绝覆盖既有证据", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "inbox-rehearsal-evidence-test-"));
    try {
      const plan = buildLegacyRehearsalPlan(parseLegacyRehearsalManifest(manifest()));
      const evidence = await executeLegacyRehearsal(plan, { dryRun: true });
      const path = join(tempRoot, "nested", "rollback-rehearsal.json");

      await writeLegacyRehearsalEvidence(path, evidence);

      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        planHash: plan.planHash,
        runId: plan.manifest.runId,
      });
      await expect(writeLegacyRehearsalEvidence(path, evidence)).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
