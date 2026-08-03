import { spawn } from "node:child_process";

import type { ReleaseCommand, ReleasePlan, ReleaseStep } from "./release-plan.js";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type CommandRunner = (command: ReleaseCommand) => Promise<CommandResult>;

export interface ReleaseStepEvidence {
  readonly commandCount: number;
  readonly description: string;
  readonly event:
    | "release.step.compensated"
    | "release.step.failed"
    | "release.step.planned"
    | "release.step.succeeded";
  readonly finishedAt: string;
  readonly id: string;
  readonly resultSummary: string;
  readonly startedAt: string;
  readonly status: "planned" | "started" | "succeeded" | "failed" | "compensated";
}

export interface ReleaseEvidence {
  readonly action: ReleasePlan["action"];
  readonly backupId: string;
  readonly cloudflareApiVersion: string;
  readonly cloudflareConsoleDeployment: string;
  readonly dryRun: boolean;
  readonly migrations: readonly string[];
  readonly planHash: string;
  readonly sealosRevision: string;
  readonly sourceCommit: string;
  readonly steps: readonly ReleaseStepEvidence[];
  readonly threeContainerDigests: ReleasePlan["manifest"]["sealos"]["images"];
}

export class ReleaseExecutionError extends Error {
  constructor(
    message: string,
    public readonly evidence: ReleaseEvidence,
  ) {
    super(message);
  }
}

export async function executeReleasePlan(
  plan: ReleasePlan,
  options: {
    readonly compensate?: boolean;
    readonly confirm?: string;
    readonly dryRun: boolean;
    readonly now?: () => Date;
    readonly runner?: CommandRunner;
  },
): Promise<ReleaseEvidence> {
  const now = options.now ?? (() => new Date());
  if (options.dryRun) {
    const at = now().toISOString();
    return evidence(plan, true, plan.steps.map((step) => ({
      commandCount: step.commands.length,
      description: step.description,
      event: "release.step.planned",
      finishedAt: at,
      id: step.id,
      resultSummary: "dry-run: no command executed",
      startedAt: at,
      status: "planned",
    })));
  }
  if (options.confirm !== plan.planHash) {
    throw new Error("实际执行必须用 --confirm 提供同一份计划的 planHash");
  }

  const runner = options.runner ?? runCommand;
  const records: ReleaseStepEvidence[] = [];
  const completed: ReleaseStep[] = [];
  for (const step of plan.steps) {
    const startedAt = now().toISOString();
    try {
      const results: CommandResult[] = [];
      for (const command of step.commands) {
        const result = await runner(command);
        results.push(result);
        if (result.exitCode !== 0) {
          throw new Error(`${step.id} command exited ${result.exitCode}: ${safeSummary(result.stderr)}`);
        }
      }
      records.push({
        commandCount: step.commands.length,
        description: step.description,
        event: "release.step.succeeded",
        finishedAt: now().toISOString(),
        id: step.id,
        resultSummary: results.map(({ stdout }) => safeSummary(stdout)).filter(Boolean).join(" | "),
        startedAt,
        status: "succeeded",
      });
      if (step.mutates) completed.push(step);
    } catch (error: unknown) {
      records.push({
        commandCount: step.commands.length,
        description: step.description,
        event: "release.step.failed",
        finishedAt: now().toISOString(),
        id: step.id,
        resultSummary: safeSummary(error instanceof Error ? error.message : "unknown error"),
        startedAt,
        status: "failed",
      });
      if (options.compensate) {
        await compensate(completed, runner, records, now);
      }
      throw new ReleaseExecutionError(
        `发布在 ${step.id} 停止，后续步骤未执行`,
        evidence(plan, false, records),
      );
    }
  }
  return evidence(plan, false, records);
}

export function runCommand(command: ReleaseCommand): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], {
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
    child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stderr, stdout }));
  });
}

async function compensate(
  completed: readonly ReleaseStep[],
  runner: CommandRunner,
  records: ReleaseStepEvidence[],
  now: () => Date,
): Promise<void> {
  for (const step of [...completed].reverse()) {
    if (step.rollbackCommands.length === 0) continue;
    const startedAt = now().toISOString();
    for (const command of step.rollbackCommands) {
      const result = await runner(command);
      if (result.exitCode !== 0) throw new Error(`补偿 ${step.id} 失败: ${safeSummary(result.stderr)}`);
    }
    records.push({
      commandCount: step.rollbackCommands.length,
      description: `${step.description} 补偿`,
      event: "release.step.compensated",
      finishedAt: now().toISOString(),
      id: `${step.id}:compensation`,
      resultSummary: "compensation succeeded",
      startedAt,
      status: "compensated",
    });
  }
}

function evidence(
  plan: ReleasePlan,
  dryRun: boolean,
  steps: readonly ReleaseStepEvidence[],
): ReleaseEvidence {
  const targetApi = plan.action === "apply"
    ? plan.manifest.cloudflare.api.targetVersion
    : plan.manifest.cloudflare.api.previousVersion;
  const targetConsole = plan.action === "apply"
    ? plan.manifest.cloudflare.console.targetDeployment
    : plan.manifest.cloudflare.console.previousCommit;
  const targetRevision = plan.action === "apply"
    ? plan.manifest.sealos.revision
    : plan.manifest.sealos.previousRevision;
  return {
    action: plan.action,
    backupId: plan.manifest.backup.id,
    cloudflareApiVersion: targetApi,
    cloudflareConsoleDeployment: targetConsole,
    dryRun,
    migrations: plan.manifest.cloudflare.database.migrations,
    planHash: plan.planHash,
    sealosRevision: targetRevision,
    sourceCommit: plan.manifest.sourceCommit,
    steps,
    threeContainerDigests: plan.manifest.sealos.images,
  };
}

function safeSummary(value: string): string {
  return value
    .replace(/((?:authorization|cookie|password|secret|token)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[url]")
    .trim()
    .slice(0, 500);
}
