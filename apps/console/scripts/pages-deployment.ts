/// <reference types="node" />

import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export interface GitDeploymentContext {
  readonly branch: string;
  readonly commitHash: string;
  readonly dirty: boolean;
}

interface DeploymentCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface PagesPreviewDeploymentPlan {
  readonly apiUrl: string;
  readonly build: DeploymentCommand;
  readonly deploy: DeploymentCommand;
  readonly environment: "preview";
}

export interface PagesDeploymentPorts {
  readonly inspectGit: () => GitDeploymentContext;
  readonly run: (
    command: string,
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ) => void;
  readonly log: (message: string) => void;
}

export interface PagesDeploymentOptions {
  readonly apiUrl: string;
  readonly dryRun: boolean;
}

export function createPagesPreviewDeploymentPlan(
  context: GitDeploymentContext,
  apiUrl: string,
): PagesPreviewDeploymentPlan {
  const branch = context.branch.trim();
  const commitHash = context.commitHash.trim();
  const normalizedApiUrl = normalizeApiUrl(apiUrl);

  if (!branch || branch === "HEAD") {
    throw new Error("拒绝发布：当前处于 detached HEAD，无法确定 Preview 分支。");
  }
  if (branch === "main") {
    throw new Error("拒绝发布：生产分支 main 不允许手工发布 Preview。");
  }
  if (context.dirty) {
    throw new Error("拒绝发布：工作区存在未提交变更，请先提交后再发布 Preview。");
  }
  if (!commitHash) {
    throw new Error("拒绝发布：无法读取当前提交哈希。");
  }

  return {
    apiUrl: normalizedApiUrl,
    build: { command: "npm", args: ["run", "build"] },
    deploy: {
      command: "wrangler",
      args: [
        "pages",
        "deploy",
        "dist",
        "--project-name",
        "inbox-server-console",
        "--branch",
        branch,
        "--commit-hash",
        commitHash,
        "--commit-dirty=false",
      ],
    },
    environment: "preview",
  };
}

export function executePagesPreviewDeployment(
  options: PagesDeploymentOptions,
  ports: PagesDeploymentPorts = defaultPorts,
): PagesPreviewDeploymentPlan {
  const plan = createPagesPreviewDeploymentPlan(ports.inspectGit(), options.apiUrl);
  const commands = [plan.build, plan.deploy];

  if (options.dryRun) {
    for (const command of commands) {
      ports.log(`[dry-run] ${[command.command, ...command.args].join(" ")}`);
    }
    return plan;
  }

  ports.run(plan.build.command, plan.build.args, {
    VITE_INBOX_API_URL: plan.apiUrl,
  });
  ports.run(plan.deploy.command, plan.deploy.args);
  return plan;
}

function normalizeApiUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:") {
    throw new Error("拒绝发布：Cloudflare API URL 必须使用 HTTPS。");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("拒绝发布：Cloudflare API URL 不能包含路径、查询参数或片段。");
  }
  return parsed.origin;
}

const defaultPorts: PagesDeploymentPorts = {
  inspectGit: () => ({
    branch: readGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    commitHash: readGit(["rev-parse", "HEAD"]),
    dirty: readGit(["status", "--porcelain"]).length > 0,
  }),
  run: (command, args, environment = {}) => {
    const result = spawnSync(command, args, {
      env: { ...process.env, ...environment },
      stdio: "inherit",
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Pages Preview 发布失败，退出码：${result.status ?? "未知"}`);
    }
  },
  log: (message) => console.log(message),
};

function readGit(args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main(): void {
  const { values } = parseArgs({
    options: {
      "api-url": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(
      "用法：tsx scripts/pages-deployment.ts --api-url https://<worker>.workers.dev [--dry-run]",
    );
    return;
  }

  executePagesPreviewDeployment({
    apiUrl: values["api-url"] ?? process.env.VITE_INBOX_API_URL ?? "",
    dryRun: values["dry-run"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
