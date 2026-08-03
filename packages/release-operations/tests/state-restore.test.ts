import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  executeStateRestoreRehearsal,
  StateRestoreRehearsalError,
  writeStateRestoreEvidence,
} from "../src/state-restore-executor";
import {
  buildStateRestorePlan,
  parseStateRestoreManifest,
  type StateKind,
} from "../src/state-restore-plan";

const repositoryRoot = resolve(process.cwd(), "../..");
const capturedAt = "2030-01-01T00:00:00.000Z";

const fixture = {
  browser: {
    records: [{ authenticated: false, profile: "synthetic-browser" }],
    schemaVersion: 1,
    stableId: "synthetic-browser-v1",
    stateKind: "browser",
  },
  warp: {
    records: [{ registrationId: "synthetic-warp", status: "registered" }],
    schemaVersion: 1,
    stableId: "synthetic-warp-v1",
    stateKind: "warp",
  },
  worker: {
    records: [{ key: "synthetic-job", status: "ready" }],
    schemaVersion: 1,
    stableId: "synthetic-worker-v1",
    stateKind: "worker",
  },
} as const;

const paths: Record<StateKind, string> = {
  browser: "deploy/rehearsal/state-snapshots/browser/state.json",
  warp: "deploy/rehearsal/state-snapshots/warp/state.json",
  worker: "deploy/rehearsal/state-snapshots/worker/state.json",
};

function digest(value: unknown): string {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function manifest() {
  return {
    candidateRpoSeconds: 86_400,
    capturedAt,
    rpoStatus: "unapproved",
    runId: "sr-20300101-000001",
    schemaVersion: 1,
    snapshots: (["worker", "browser", "warp"] as const).map((stateKind) => ({
      fileCount: 1,
      path: paths[stateKind],
      recordCount: fixture[stateKind].records.length,
      schemaVersion: 1,
      sha256: digest(fixture[stateKind]),
      snapshotId: `snapshot-${stateKind}-v1`,
      stableId: fixture[stateKind].stableId,
      stateKind,
    })),
    sourceCommit: "3".repeat(40),
  };
}

function now(): Date {
  return new Date("2030-01-01T01:00:00.000Z");
}

describe("isolated state restore rehearsal", () => {
  it("固定三类 manifest 生成稳定计划，dry-run 完全不访问文件系统", async () => {
    const plan = buildStateRestorePlan(parseStateRestoreManifest(manifest()));
    const duplicate = buildStateRestorePlan(parseStateRestoreManifest(manifest()));
    const io = {
      chmod: vi.fn(),
      lstat: vi.fn(),
      mkdir: vi.fn(),
      mkdtemp: vi.fn(),
      readFile: vi.fn(),
      rm: vi.fn(),
      writeFile: vi.fn(),
    };

    const evidence = await executeStateRestoreRehearsal(plan, { dryRun: true, io });

    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.planHash).toBe(duplicate.planHash);
    expect(plan.restoreName).toBe("inbox-state-restore-sr-20300101-000001");
    expect(plan.steps.map(({ id }) => id)).toEqual([
      "snapshot-preflight",
      "restore",
      "startup-gate",
      "reconciliation",
      "cleanup",
    ]);
    expect(evidence).toMatchObject({
      counters: { externalCalls: 0, productionMutations: 0, sensitiveMatches: 0 },
      dryRun: true,
      event: "operations.state_restore_rehearsal.planned",
      planHash: plan.planHash,
      rpoStatus: "unapproved",
      traceId: "TC-002",
    });
    expect(Object.values(io).every((operation) => operation.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ["额外字段", { command: "kubectl get pvc" }],
    ["URL", { sourceUrl: "https://example.invalid/state" }],
    ["生产路径", {
      snapshots: manifest().snapshots.map((snapshot, index) => index === 0
        ? { ...snapshot, path: "/var/lib/worker/state.json" }
        : snapshot),
    }],
    ["重复快照", { snapshots: [manifest().snapshots[0], manifest().snapshots[0], manifest().snapshots[2]] }],
  ])("拒绝 manifest 的%s", (_label, extra) => {
    expect(() => parseStateRestoreManifest({ ...manifest(), ...extra })).toThrow();
  });

  it("摘要错误在创建恢复目录前 fail-closed", async () => {
    const invalid = manifest();
    invalid.snapshots = invalid.snapshots.map((snapshot, index) => index === 0
      ? { ...snapshot, sha256: "a".repeat(64) }
      : snapshot);
    const plan = buildStateRestorePlan(parseStateRestoreManifest(invalid));
    const mkdtempSpy = vi.fn();

    const failure = await executeStateRestoreRehearsal(plan, {
      confirm: plan.planHash,
      dryRun: false,
      io: {
        mkdtemp: mkdtempSpy,
      },
      now,
      repositoryRoot,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StateRestoreRehearsalError);
    expect(mkdtempSpy).not.toHaveBeenCalled();
    expect((failure as StateRestoreRehearsalError).evidence).toMatchObject({
      event: "operations.state_restore_rehearsal.failed",
      residuals: { tempDirs: 0 },
    });
  });

  it("拒绝符号链接快照且不泄露本机路径", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "inbox-state-symlink-test-"));
    const source = join(tempRoot, "state.json");
    const link = join(tempRoot, "state-link.json");
    await writeFile(source, `${JSON.stringify(fixture.worker, null, 2)}\n`);
    await symlink(source, link);
    const plan = buildStateRestorePlan(parseStateRestoreManifest(manifest()));

    try {
      const failure = await executeStateRestoreRehearsal(plan, {
        confirm: plan.planHash,
        dryRun: false,
        io: {
          resolveSourcePath: () => link,
        },
        now,
        repositoryRoot,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(StateRestoreRehearsalError);
      expect(JSON.stringify((failure as StateRestoreRehearsalError).evidence)).not.toContain(tempRoot);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("恢复 Worker、浏览器与 WARP 状态，通过启动门禁、对账和权限检查", async () => {
    const plan = buildStateRestorePlan(parseStateRestoreManifest(manifest()));
    const evidence = await executeStateRestoreRehearsal(plan, {
      confirm: plan.planHash,
      dryRun: false,
      now,
      repositoryRoot,
    });

    expect(evidence.event).toBe("operations.state_restore_rehearsal.completed");
    expect(evidence.states.map(({ stateKind }) => stateKind)).toEqual(["worker", "browser", "warp"]);
    expect(evidence.states.every(({ mode, reconciled }) => mode === "0600" && reconciled)).toBe(true);
    expect(evidence.rtoMilliseconds).toBeLessThanOrEqual(900_000);
    expect(evidence.candidateRpo).toEqual({
      observedMilliseconds: 3_600_000,
      productionStatus: "unapproved",
      status: "candidate_verified",
      targetMilliseconds: 86_400_000,
      withinCandidate: true,
    });
    expect(evidence.rpoStatus).toBe("unapproved");
    expect(evidence.counters).toEqual({
      commandsExecuted: 0,
      externalCalls: 0,
      productionMutations: 0,
      sensitiveMatches: 0,
    });
    expect(evidence.residuals).toEqual({ tempDirs: 0 });
  });

  it("候选 RPO 计算到恢复真正开始而不是预检开始", async () => {
    const plan = buildStateRestorePlan(parseStateRestoreManifest(manifest()));
    let offset = 3_599_000;
    const progressiveNow = () => {
      offset += 1_000;
      return new Date(new Date(capturedAt).getTime() + offset);
    };

    const evidence = await executeStateRestoreRehearsal(plan, {
      confirm: plan.planHash,
      dryRun: false,
      now: progressiveNow,
      repositoryRoot,
    });

    expect(evidence.candidateRpo.observedMilliseconds).toBe(3_601_000);
  });

  it("启动门禁失败后仍清理临时目录并脱敏失败证据", async () => {
    const plan = buildStateRestorePlan(parseStateRestoreManifest(manifest()));
    let restoredRoot = "";

    const failure = await executeStateRestoreRehearsal(plan, {
      confirm: plan.planHash,
      dryRun: false,
      hooks: {
        afterRestore: async (root) => {
          restoredRoot = root;
          throw new Error("token=synthetic-secret https://example.invalid/private");
        },
      },
      now,
      repositoryRoot,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StateRestoreRehearsalError);
    expect(await lstat(restoredRoot).then(() => true).catch(() => false)).toBe(false);
    expect((failure as StateRestoreRehearsalError).evidence.residuals).toEqual({ tempDirs: 0 });
    expect((failure as StateRestoreRehearsalError).evidence.counters.sensitiveMatches).toBe(0);
    expect(JSON.stringify((failure as StateRestoreRehearsalError).evidence)).not.toMatch(
      /synthetic-secret|example\.invalid/,
    );
    expect((failure as StateRestoreRehearsalError).evidence.steps.at(-1)).toMatchObject({
      event: "operations.state_restore_rehearsal.cleanup_completed",
      status: "succeeded",
    });
  });

  it("证据写入创建父目录、权限为 0600 且拒绝覆盖", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "inbox-state-evidence-test-"));
    const plan = buildStateRestorePlan(parseStateRestoreManifest(manifest()));
    const evidence = await executeStateRestoreRehearsal(plan, { dryRun: true });
    const path = join(tempRoot, "nested", "state-restore-rehearsal.json");

    try {
      await writeStateRestoreEvidence(path, evidence);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ traceId: "TC-002" });
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      await expect(writeStateRestoreEvidence(path, evidence)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
