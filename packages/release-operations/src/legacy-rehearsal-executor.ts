import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type {
  LegacyRehearsalManifest,
  LegacyRehearsalPlan,
  LegacyRehearsalStep,
} from "./legacy-rehearsal-plan.js";
import type { CommandResult, CommandRunner } from "./release-executor.js";

export interface D1CompatibilityResult {
  readonly legacyWriteCount: number;
  readonly migrationCount: number;
  readonly stableDigest: string;
}

export interface LegacyRehearsalStepEvidence {
  readonly commandCount: number;
  readonly description: string;
  readonly event:
    | "operations.rollback_rehearsal.cleanup_completed"
    | "operations.rollback_rehearsal.cleanup_failed"
    | "operations.rollback_rehearsal.step_completed"
    | "operations.rollback_rehearsal.step_failed"
    | "operations.rollback_rehearsal.step_planned";
  readonly finishedAt: string;
  readonly id: LegacyRehearsalStep["id"] | "cleanup";
  readonly resultSummary: string;
  readonly startedAt: string;
  readonly status: "failed" | "planned" | "succeeded";
}

export interface LegacyRehearsalEvidence {
  readonly d1Compatibility: D1CompatibilityResult | null;
  readonly dryRun: boolean;
  readonly event: "operations.rollback_rehearsal.completed" | "operations.rollback_rehearsal.failed";
  readonly identity: {
    readonly backupId: string;
    readonly backupSha256: string;
    readonly cloudflareApiVersion: string;
    readonly consoleCommit: string;
    readonly migrations: readonly string[];
    readonly sourceCommit: string;
    readonly threeContainerDigests: LegacyRehearsalManifest["images"];
  };
  readonly planHash: string;
  readonly projectName: string;
  readonly residuals: {
    readonly containers: number;
    readonly networks: number;
    readonly tempFiles: number;
    readonly volumes: number;
  };
  readonly rtoMilliseconds: number | null;
  readonly runId: string;
  readonly steps: readonly LegacyRehearsalStepEvidence[];
  readonly traceId: "TC-001";
}

export class LegacyRehearsalError extends Error {
  constructor(
    message: string,
    public readonly evidence: LegacyRehearsalEvidence,
  ) {
    super(message);
  }
}

export async function writeLegacyRehearsalEvidence(
  path: string,
  value: LegacyRehearsalEvidence,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

type IdentityCheck = (
  manifest: LegacyRehearsalManifest,
  repositoryRoot: string,
) => Promise<void>;

type D1Check = (
  manifest: LegacyRehearsalManifest,
  options: { readonly repositoryRoot: string; readonly tempRoot: string },
) => Promise<D1CompatibilityResult>;

export async function executeLegacyRehearsal(
  plan: LegacyRehearsalPlan,
  options: {
    readonly confirm?: string;
    readonly d1Check?: D1Check;
    readonly dryRun: boolean;
    readonly identityCheck?: IdentityCheck;
    readonly now?: () => Date;
    readonly repositoryRoot?: string;
    readonly runner?: CommandRunner;
  },
): Promise<LegacyRehearsalEvidence> {
  const now = options.now ?? (() => new Date());
  if (options.dryRun) {
    const at = now().toISOString();
    return evidence(plan, {
      d1Compatibility: null,
      dryRun: true,
      event: "operations.rollback_rehearsal.completed",
      residuals: zeroResiduals(),
      rtoMilliseconds: null,
      steps: plan.steps.map((step) => ({
        commandCount: step.commands.length,
        description: step.description,
        event: "operations.rollback_rehearsal.step_planned",
        finishedAt: at,
        id: step.id,
        resultSummary: "dry-run: no command executed",
        startedAt: at,
        status: "planned",
      })),
    });
  }
  if (options.confirm !== plan.planHash) {
    throw new Error("实际演练必须用 --confirm 提供同一份计划的 planHash");
  }

  const repositoryRoot = resolve(options.repositoryRoot ?? fileURLToPath(
    new URL("../../../", import.meta.url),
  ));
  const tempRoot = await mkdtemp(join(tmpdir(), `inbox-${plan.manifest.runId}-`));
  const runner = options.runner ?? ((command) => runCommandAtRoot(command, repositoryRoot));
  const d1Check = options.d1Check ?? runD1CompatibilityCheck;
  const identityCheck = options.identityCheck ?? verifyRehearsalIdentity;
  const records: LegacyRehearsalStepEvidence[] = [];
  let d1Compatibility: D1CompatibilityResult | null = null;
  let failure: unknown;
  let rtoStartedAt: number | null = null;
  let rtoMilliseconds: number | null = null;

  for (const step of plan.steps) {
    if (failure) break;
    const startedAt = now();
    if (step.id === "substitute-worker-stop") rtoStartedAt = startedAt.getTime();
    try {
      const results = await executeStep(step, {
        d1Check,
        identityCheck,
        manifest: plan.manifest,
        repositoryRoot,
        runner,
        tempRoot,
      });
      if (step.id === "legacy-compose-restore" && rtoStartedAt !== null) {
        rtoMilliseconds = now().getTime() - rtoStartedAt;
        if (rtoMilliseconds > plan.manifest.rtoSeconds * 1_000) {
          throw new Error(`RTO ${rtoMilliseconds}ms 超过 ${plan.manifest.rtoSeconds * 1_000}ms`);
        }
      }
      if (step.id === "d1-compatibility") d1Compatibility = results.d1Compatibility;
      if (step.id === "reconciliation") assertReconciliation(plan, results.commands);
      records.push(stepRecord(step, startedAt, now(), "succeeded", successSummary(step)));
    } catch (error: unknown) {
      failure = error;
      records.push(stepRecord(
        step,
        startedAt,
        now(),
        "failed",
        safeSummary(error instanceof Error ? error.message : "unknown error"),
      ));
    }
  }

  const cleanup = await cleanupRehearsal(plan, runner, tempRoot, now);
  records.push(cleanup.record);
  if (!failure && cleanup.failure) failure = cleanup.failure;
  const finalEvidence = evidence(plan, {
    d1Compatibility,
    dryRun: false,
    event: failure
      ? "operations.rollback_rehearsal.failed"
      : "operations.rollback_rehearsal.completed",
    residuals: cleanup.residuals,
    rtoMilliseconds,
    steps: records,
  });
  if (failure) {
    throw new LegacyRehearsalError(
      `隔离回滚演练失败: ${safeSummary(failure instanceof Error ? failure.message : "unknown error")}`,
      finalEvidence,
    );
  }
  return finalEvidence;
}

export async function runD1CompatibilityCheck(
  manifest: LegacyRehearsalManifest,
  options: { readonly repositoryRoot: string; readonly tempRoot: string },
): Promise<D1CompatibilityResult> {
  const migrations = await Promise.all(manifest.d1.migrations.map(async (path) => ({
    path,
    sql: await readFile(resolve(options.repositoryRoot, path), "utf8"),
  })));
  const cutoff = migrations.findIndex(({ path }) => path === manifest.d1.legacyCutoff);
  if (cutoff < 0) throw new Error("D1 legacy cutoff 不在 migration 列表中");
  const unsafe = migrations.slice(cutoff + 1).find(({ sql }) =>
    /\b(?:DELETE\s+FROM|DROP\s+TABLE|REPLACE\s+INTO|TRUNCATE)\b/i.test(sql));
  if (unsafe) throw new Error(`D1 migration ${unsafe.path} 包含未允许的破坏性语句`);

  const database = new DatabaseSync(join(options.tempRoot, "d1-rehearsal.sqlite"));
  try {
    for (const { sql } of migrations.slice(0, cutoff + 1)) database.exec(sql);
    database.prepare(
      `INSERT INTO worker_jobs
       (dedupe_key, job_id, kind, item_kind, status, attempts, summary,
        created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "rehearsal:legacy:1",
      "legacy-job-1",
      "dispatch-item",
      "link",
      "done",
      1,
      JSON.stringify({ source: "synthetic" }),
      "2030-01-01T00:00:00.000Z",
      "2030-01-01T00:00:01.000Z",
      "2030-01-01T00:00:01.000Z",
    );
    for (const { sql } of migrations.slice(cutoff + 1)) database.exec(sql);
    const first = stableD1Snapshot(database);
    for (const { sql } of migrations.slice(cutoff + 1)) database.exec(sql);
    const second = stableD1Snapshot(database);
    if (first !== second) throw new Error("D1 migration 重放后稳定摘要发生变化");
    return {
      legacyWriteCount: 1,
      migrationCount: migrations.length,
      stableDigest: first,
    };
  } finally {
    database.close();
  }
}

async function executeStep(
  step: LegacyRehearsalStep,
  context: {
    readonly d1Check: D1Check;
    readonly identityCheck: IdentityCheck;
    readonly manifest: LegacyRehearsalManifest;
    readonly repositoryRoot: string;
    readonly runner: CommandRunner;
    readonly tempRoot: string;
  },
): Promise<{ readonly commands: readonly CommandResult[]; readonly d1Compatibility: D1CompatibilityResult | null }> {
  if (step.id === "identity-evidence") {
    await context.identityCheck(context.manifest, context.repositoryRoot);
  }
  const d1Compatibility = step.id === "d1-compatibility"
    ? await context.d1Check(context.manifest, {
        repositoryRoot: context.repositoryRoot,
        tempRoot: context.tempRoot,
      })
    : null;
  const commands: CommandResult[] = [];
  for (const command of step.commands) {
    const result = await context.runner(command);
    commands.push(result);
    if (result.exitCode !== 0) {
      throw new Error(`${step.id} command exited ${result.exitCode}: ${safeSummary(result.stderr)}`);
    }
  }
  return { commands, d1Compatibility };
}

async function verifyRehearsalIdentity(
  manifest: LegacyRehearsalManifest,
  repositoryRoot: string,
): Promise<void> {
  const seed = await readFile(resolve(repositoryRoot, manifest.assets.postgresSeedPath));
  const digest = createHash("sha256").update(seed).digest("hex");
  if (digest !== manifest.backup.sha256) throw new Error("合成备份 sha256 与 manifest 不一致");
}

async function cleanupRehearsal(
  plan: LegacyRehearsalPlan,
  runner: CommandRunner,
  tempRoot: string,
  now: () => Date,
): Promise<{
  readonly failure: unknown;
  readonly record: LegacyRehearsalStepEvidence;
  readonly residuals: LegacyRehearsalEvidence["residuals"];
}> {
  const startedAt = now();
  const results: CommandResult[] = [];
  let failure: unknown;
  for (const command of plan.cleanupCommands) {
    try {
      const result = await runner(command);
      results.push(result);
      if (result.exitCode !== 0 && !failure) {
        failure = new Error(`cleanup command exited ${result.exitCode}: ${safeSummary(result.stderr)}`);
      }
    } catch (error: unknown) {
      if (!failure) failure = error;
      results.push({ exitCode: 1, stderr: safeSummary(error instanceof Error ? error.message : "unknown"), stdout: "" });
    }
  }
  await rm(tempRoot, { force: true, recursive: true });
  const tempFiles = await exists(tempRoot) ? 1 : 0;
  const residuals = {
    containers: resultCount(results[1]),
    networks: resultCount(results[2]),
    tempFiles,
    volumes: resultCount(results[3]),
  };
  if (Object.values(residuals).some((count) => count !== 0) && !failure) {
    failure = new Error(`cleanup 残留不为 0: ${JSON.stringify(residuals)}`);
  }
  return {
    failure,
    record: {
      commandCount: plan.cleanupCommands.length,
      description: "无论成功或失败都清理临时容器、网络、卷和文件",
      event: failure
        ? "operations.rollback_rehearsal.cleanup_failed"
        : "operations.rollback_rehearsal.cleanup_completed",
      finishedAt: now().toISOString(),
      id: "cleanup",
      resultSummary: failure
        ? safeSummary(failure instanceof Error ? failure.message : "cleanup failed")
        : `cleanup completed: ${JSON.stringify(residuals)}`,
      startedAt: startedAt.toISOString(),
      status: failure ? "failed" : "succeeded",
    },
    residuals,
  };
}

function assertReconciliation(
  plan: LegacyRehearsalPlan,
  results: readonly CommandResult[],
): void {
  const services = composeServices(results[0]?.stdout ?? "");
  for (const expected of ["postgres", "redis", "server", "worker"]) {
    const service = services.find((candidate) => candidate.service === expected);
    if (!service || service.state !== "running" || service.health !== "healthy") {
      throw new Error(`Compose service ${expected} 未达到 running/healthy`);
    }
    if (service.publishedPorts > 0) throw new Error(`Compose service ${expected} 禁止发布宿主端口`);
  }
  if ((results[1]?.stdout ?? "").trim() !== `${plan.manifest.backup.id}|1`) {
    throw new Error("合成备份标记对账失败");
  }
}

function composeServices(stdout: string): readonly {
  readonly health: string;
  readonly publishedPorts: number;
  readonly service: string;
  readonly state: string;
}[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("docker compose ps 未返回服务");
  const parsed = trimmed.startsWith("[")
    ? JSON.parse(trimmed) as unknown[]
    : trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  return parsed.map((value) => {
    const item = value as Record<string, unknown>;
    const publishers = Array.isArray(item.Publishers)
      ? item.Publishers.filter((publisher) => {
          if (typeof publisher !== "object" || publisher === null) return false;
          const publishedPort = (publisher as Record<string, unknown>).PublishedPort;
          return typeof publishedPort === "number" && publishedPort > 0;
        }).length
      : 0;
    return {
      health: String(item.Health ?? ""),
      publishedPorts: publishers,
      service: String(item.Service ?? ""),
      state: String(item.State ?? ""),
    };
  });
}

function stableD1Snapshot(database: DatabaseSync): string {
  const row = database.prepare(
    `SELECT dedupe_key, job_id, kind, item_kind, status, attempts, summary,
            created_at, updated_at, finished_at
     FROM worker_jobs WHERE job_id = ?`,
  ).get("legacy-job-1");
  if (!row) throw new Error("D1 最新 schema 无法读取旧 Worker 写入");
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

function stepRecord(
  step: LegacyRehearsalStep,
  startedAt: Date,
  finishedAt: Date,
  status: "failed" | "succeeded",
  resultSummary: string,
): LegacyRehearsalStepEvidence {
  return {
    commandCount: step.commands.length,
    description: step.description,
    event: status === "failed"
      ? "operations.rollback_rehearsal.step_failed"
      : "operations.rollback_rehearsal.step_completed",
    finishedAt: finishedAt.toISOString(),
    id: step.id,
    resultSummary,
    startedAt: startedAt.toISOString(),
    status,
  };
}

function evidence(
  plan: LegacyRehearsalPlan,
  input: Pick<LegacyRehearsalEvidence,
    "d1Compatibility" | "dryRun" | "event" | "residuals" | "rtoMilliseconds" | "steps">,
): LegacyRehearsalEvidence {
  return {
    ...input,
    identity: {
      backupId: plan.manifest.backup.id,
      backupSha256: plan.manifest.backup.sha256,
      cloudflareApiVersion: plan.manifest.cloudflare.apiPreviousVersion,
      consoleCommit: plan.manifest.cloudflare.consolePreviousCommit,
      migrations: plan.manifest.d1.migrations,
      sourceCommit: plan.manifest.sourceCommit,
      threeContainerDigests: plan.manifest.images,
    },
    planHash: plan.planHash,
    projectName: plan.projectName,
    runId: plan.manifest.runId,
    traceId: "TC-001",
  };
}

function zeroResiduals(): LegacyRehearsalEvidence["residuals"] {
  return { containers: 0, networks: 0, tempFiles: 0, volumes: 0 };
}

function resultCount(result: CommandResult | undefined): number {
  if (!result || result.exitCode !== 0) return -1;
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

function successSummary(step: LegacyRehearsalStep): string {
  const summaries: Record<LegacyRehearsalStep["id"], string> = {
    "d1-compatibility": "D1 legacy write, latest read and migration replay verified",
    "identity-evidence": "backup and immutable deployment identities verified",
    "isolation-preflight": "isolated compose validated and legacy runtime images built",
    "legacy-compose-restore": "legacy server and worker reached healthy state",
    reconciliation: "compose health and synthetic backup marker reconciled",
    "substitute-worker-stop": "substitute worker started and stopped",
  };
  return summaries[step.id];
}

function safeSummary(value: string): string {
  return value
    .replace(/((?:authorization|cookie|password|secret|token)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[url]")
    .replace(/\/(?:Users|private\/tmp)\/[^\s:]+/g, "[path]")
    .trim()
    .slice(0, 500);
}

function runCommandAtRoot(
  command: Parameters<CommandRunner>[0],
  repositoryRoot: string,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.file, [...command.args], {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise({
      exitCode: exitCode ?? 1,
      stderr,
      stdout,
    }));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
