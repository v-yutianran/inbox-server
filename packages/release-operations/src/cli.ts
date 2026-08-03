import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cac } from "cac";

import {
  executeLegacyRehearsal,
  LegacyRehearsalError,
  writeLegacyRehearsalEvidence,
} from "./legacy-rehearsal-executor.js";
import {
  buildLegacyRehearsalPlan,
  parseLegacyRehearsalManifest,
  type LegacyRehearsalPlan,
} from "./legacy-rehearsal-plan.js";
import { executeReleasePlan, ReleaseExecutionError } from "./release-executor.js";
import {
  buildReleasePlan,
  parseReleaseManifest,
  type ReleaseAction,
  type ReleasePlan,
} from "./release-plan.js";

interface CommonOptions {
  readonly compensate?: boolean;
  readonly confirm?: string;
  readonly dryRun?: boolean;
  readonly evidence?: string;
  readonly manifest: string;
}

const cli = cac("inbox-release");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

cli
  .command("plan", "生成不可变发布或回滚计划")
  .option("--manifest <path>", "release manifest JSON 路径")
  .option("--action <action>", "apply 或 rollback", { default: "apply" })
  .action(async (options: { action: string; manifest?: string }) => {
    const plan = await loadPlan(action(options.action), requiredManifest(options.manifest));
    print(plan);
  });

for (const actionName of ["apply", "rollback"] as const) {
  cli
    .command(actionName, actionName === "apply" ? "执行发布计划" : "执行回滚计划")
    .option("--manifest <path>", "release manifest JSON 路径")
    .option("--dry-run", "只输出同参数计划，禁止执行任何命令")
    .option("--confirm <planHash>", "实际执行时确认同一 planHash")
    .option("--compensate", "失败时按已完成步骤逆序执行补偿（需独立回滚授权）")
    .option("--evidence <path>", "实际执行后写入脱敏证据 JSON")
    .action(async (options: CommonOptions) => {
      const plan = await loadPlan(actionName, requiredManifest(options.manifest));
      try {
        const result = await executeReleasePlan(plan, {
          compensate: options.compensate === true,
          ...(options.confirm ? { confirm: options.confirm } : {}),
          dryRun: options.dryRun === true,
        });
        print(result);
        if (options.evidence && !options.dryRun) {
          await writeFile(options.evidence, `${JSON.stringify(result, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
          });
        }
      } catch (error: unknown) {
        if (error instanceof ReleaseExecutionError) print(error.evidence);
        throw error;
      }
    });
}

cli
  .command("rehearse-legacy", "在强隔离环境演练恢复旧 Docker Compose 路径")
  .option("--manifest <path>", "隔离 rehearsal manifest JSON 路径")
  .option("--dry-run", "只输出同参数计划，禁止执行命令和写文件")
  .option("--confirm <planHash>", "实际演练时确认同一 planHash")
  .option("--evidence <path>", "实际演练后写入脱敏证据 JSON")
  .action(async (options: CommonOptions) => {
    const plan = await loadLegacyRehearsalPlan(requiredManifest(options.manifest));
    try {
      const result = await executeLegacyRehearsal(plan, {
        ...(options.confirm ? { confirm: options.confirm } : {}),
        dryRun: options.dryRun === true,
        repositoryRoot,
      });
      print(result);
      if (options.evidence && !options.dryRun) {
        await writeLegacyRehearsalEvidence(repositoryPath(options.evidence), result);
      }
    } catch (error: unknown) {
      if (error instanceof LegacyRehearsalError) print(error.evidence);
      throw error;
    }
  });

cli.help();

try {
  cli.parse(undefined, { run: false });
  await cli.runMatchedCommand();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "release command failed");
  process.exitCode = 1;
}

async function loadPlan(actionName: ReleaseAction, path: string): Promise<ReleasePlan> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return buildReleasePlan(actionName, parseReleaseManifest(raw));
}

async function loadLegacyRehearsalPlan(path: string): Promise<LegacyRehearsalPlan> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return buildLegacyRehearsalPlan(parseLegacyRehearsalManifest(raw));
}

function action(value: string): ReleaseAction {
  if (value === "apply" || value === "rollback") return value;
  throw new Error("--action 只允许 apply 或 rollback");
}

function requiredManifest(value: string | undefined): string {
  if (!value) throw new Error("--manifest 为必填参数");
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function repositoryPath(path: string): string {
  const resolved = resolve(repositoryRoot, path);
  if (!resolved.startsWith(`${resolve(repositoryRoot)}${sep}`)) {
    throw new Error("--evidence 必须是仓库内相对路径");
  }
  return resolved;
}
