import { describe, expect, it, vi } from "vitest";

import {
  executeReleasePlan,
  ReleaseExecutionError,
  type CommandRunner,
} from "../src/release-executor";
import { buildReleasePlan, parseReleaseManifest } from "../src/release-plan";

const digest = (suffix: string) =>
  `ghcr.nju.edu.cn/v-yutianran/${suffix}@sha256:${"a".repeat(64)}`;

function manifest() {
  return {
    backup: { id: "d1-bookmark-20300101", verifiedAt: "2030-01-01T00:00:00.000Z" },
    canary: { fixtureSet: "article-fixed-v1" },
    cloudflare: {
      api: {
        name: "inbox-server-api",
        previousVersion: "11111111-1111-4111-8111-111111111111",
        targetVersion: "22222222-2222-4222-8222-222222222222",
      },
      console: {
        artifactDir: "apps/console/dist",
        branch: "main",
        previousArtifactDir: "artifacts/console/previous",
        previousCommit: "1".repeat(40),
        projectName: "inbox-server-console",
        targetDeployment: "console-deployment-v2",
      },
      database: {
        migrations: ["apps/api/migrations/0005_operations_readiness.sql"],
        name: "inbox-server",
      },
    },
    exitGate: { apiHealthUrl: "https://inbox-api.example.com/healthz", stabilitySeconds: 600 },
    schemaVersion: 1,
    sealos: {
      context: "sealos-bja-ns-tbs948af",
      images: {
        mihomo: { previous: digest("mihomo-old"), target: digest("mihomo-new") },
        warp: { previous: digest("warp-old"), target: digest("warp-new") },
        worker: { previous: digest("worker-old"), target: digest("worker-new") },
      },
      manifestPath: "deploy/sealos/worker-staging.yaml",
      namespace: "ns-tbs948af",
      previousRevision: "revision-1",
      revision: "revision-2",
      rollbackManifestPath: "deploy/sealos/worker-rollback.yaml",
      workloadName: "inbox-server-worker-staging",
    },
    secrets: [{ name: "inbox-worker-staging", versionRef: "resourceVersion:18" }],
    sourceCommit: "2".repeat(40),
  };
}

describe("release operations", () => {
  it("固定 manifest 生成稳定 planHash 与唯一执行顺序", () => {
    const parsed = parseReleaseManifest(manifest());
    const first = buildReleasePlan("apply", parsed);
    const second = buildReleasePlan("apply", parsed);

    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.planHash).toBe(second.planHash);
    expect(first.steps.map(({ id }) => id)).toEqual([
      "preflight",
      "backup-evidence",
      "expand-migration",
      "api",
      "console",
      "worker",
      "isolated-canary",
      "stability-window",
    ]);
    const stability = first.steps.find(({ id }) => id === "stability-window");
    expect(stability?.commands[0]?.args).toEqual(expect.arrayContaining([
      "--health-url",
      "https://inbox-api.example.com/healthz",
      "--stability-seconds",
      "600",
    ]));
  });

  it("dry-run 与实际计划共用 planHash 且完全不调用执行器", async () => {
    const runner = vi.fn<CommandRunner>();
    const plan = buildReleasePlan("apply", parseReleaseManifest(manifest()));

    const evidence = await executeReleasePlan(plan, { dryRun: true, runner });

    expect(evidence.planHash).toBe(plan.planHash);
    expect(evidence.steps.every(({ status }) => status === "planned")).toBe(true);
    expect(evidence.steps.every(({ event }) => event === "release.step.planned")).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it("拒绝可变 tag、本机 context 和 manifest 内 Secret 原值", () => {
    const tagged = manifest();
    tagged.sealos.images.worker.target = "ghcr.nju.edu.cn/v-yutianran/worker:latest";
    expect(() => parseReleaseManifest(tagged)).toThrow(/sha256 digest/);

    const localContext = manifest();
    localContext.sealos.context = "orbstack";
    expect(() => parseReleaseManifest(localContext)).toThrow(/本机 Kubernetes/);

    const leaked = manifest() as ReturnType<typeof manifest> & { secrets: Array<Record<string, string>> };
    leaked.secrets = [{ name: "worker", versionRef: "v1", value: "raw-secret" }];
    expect(() => parseReleaseManifest(leaked)).toThrow(/禁止保存敏感原值/);
  });

  it("实际执行缺少同一 planHash 时在首条命令前失败", async () => {
    const runner = vi.fn<CommandRunner>();
    const plan = buildReleasePlan("apply", parseReleaseManifest(manifest()));

    await expect(executeReleasePlan(plan, {
      confirm: "wrong-plan",
      dryRun: false,
      runner,
    })).rejects.toThrow(/planHash/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("预检首条命令失败时不执行部署并记录稳定事件", async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue({
      exitCode: 1,
      stderr: "synthetic preflight failure",
      stdout: "",
    });
    const plan = buildReleasePlan("apply", parseReleaseManifest(manifest()));

    const failure = await executeReleasePlan(plan, {
      confirm: plan.planHash,
      dryRun: false,
      runner,
    }).catch((error: unknown) => error);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(ReleaseExecutionError);
    expect((failure as ReleaseExecutionError).evidence.steps).toMatchObject([
      { event: "release.step.failed", id: "preflight", status: "failed" },
    ]);
  });

  it("步骤失败立即停止，未执行后续 Console 和 Worker", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      const rendered = [command.file, ...command.args].join(" ");
      calls.push(rendered);
      return {
        exitCode: rendered.includes("run deploy --workspace @inbox/api") ? 1 : 0,
        stderr: rendered.includes("run deploy --workspace @inbox/api") ? "synthetic failure" : "",
        stdout: "ok",
      };
    };
    const plan = buildReleasePlan("apply", parseReleaseManifest(manifest()));

    const failure = await executeReleasePlan(plan, {
      confirm: plan.planHash,
      dryRun: false,
      runner,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReleaseExecutionError);
    expect((failure as ReleaseExecutionError).evidence.steps.at(-1)?.event).toBe(
      "release.step.failed",
    );
    expect(calls.some((value) => value.includes("pages deploy"))).toBe(false);
    expect(calls.some((value) => value.includes("kubectl") && value.includes("apply"))).toBe(false);
  });

  it("显式补偿只回退已成功变更的单元", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      const rendered = [command.file, ...command.args].join(" ");
      calls.push(rendered);
      const consoleDeploy = rendered.includes("pages deploy apps/console/dist");
      return { exitCode: consoleDeploy ? 1 : 0, stderr: consoleDeploy ? "failed" : "", stdout: "ok" };
    };
    const plan = buildReleasePlan("apply", parseReleaseManifest(manifest()));

    await expect(executeReleasePlan(plan, {
      compensate: true,
      confirm: plan.planHash,
      dryRun: false,
      runner,
    })).rejects.toBeInstanceOf(ReleaseExecutionError);
    expect(calls.some((value) => value.includes("versions deploy 11111111-1111-4111-8111-111111111111@100%"))).toBe(true);
    expect(calls.some((value) => value.includes("worker-rollback.yaml"))).toBe(false);
  });

  it("回滚计划只选择上一 API、Console 产物和三容器 manifest", () => {
    const plan = buildReleasePlan("rollback", parseReleaseManifest(manifest()));
    const commands = plan.steps.flatMap(({ commands }) => commands)
      .map((command) => [command.file, ...command.args].join(" "));

    expect(commands).toEqual(expect.arrayContaining([
      expect.stringContaining("11111111-1111-4111-8111-111111111111@100%"),
      expect.stringContaining("artifacts/console/previous"),
      expect.stringContaining("deploy/sealos/worker-rollback.yaml"),
    ]));
    expect(commands.some((value) => value.includes("db:migrate:remote"))).toBe(false);
  });

  it("隔离回滚演练执行上一 API version 与 Worker manifest 并记录成功事件", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (command) => {
      calls.push([command.file, ...command.args].join(" "));
      return { exitCode: 0, stderr: "", stdout: "synthetic ok" };
    };
    const plan = buildReleasePlan("rollback", parseReleaseManifest(manifest()));

    const evidence = await executeReleasePlan(plan, {
      confirm: plan.planHash,
      dryRun: false,
      runner,
    });

    expect(calls).toEqual(expect.arrayContaining([
      expect.stringContaining("11111111-1111-4111-8111-111111111111@100%"),
      expect.stringContaining("deploy/sealos/worker-rollback.yaml"),
    ]));
    expect(evidence.steps.every(({ event }) => event === "release.step.succeeded")).toBe(true);
  });
});
