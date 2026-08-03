import { readFile, writeFile } from "node:fs/promises";

import { cac } from "cac";

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
