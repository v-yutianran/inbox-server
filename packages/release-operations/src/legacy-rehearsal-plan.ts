import { createHash } from "node:crypto";

import type { ReleaseCommand } from "./release-plan.js";

export interface LegacyRehearsalManifest {
  readonly assets: {
    readonly channelsPath: "deploy/rehearsal/synthetic-channels.yml";
    readonly composePath: "deploy/rehearsal/compose.yml";
    readonly postgresSeedPath: "deploy/rehearsal/postgres-seed.sql";
  };
  readonly backup: { readonly id: string; readonly sha256: string };
  readonly cloudflare: {
    readonly apiPreviousVersion: string;
    readonly consolePreviousCommit: string;
  };
  readonly d1: {
    readonly legacyCutoff: "apps/api/migrations/0004_article_retry_safety.sql";
    readonly migrations: readonly string[];
  };
  readonly images: {
    readonly mihomo: string;
    readonly warp: string;
    readonly worker: string;
  };
  readonly rtoSeconds: number;
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
}

export interface LegacyRehearsalStep {
  readonly commands: readonly ReleaseCommand[];
  readonly description: string;
  readonly id:
    | "d1-compatibility"
    | "identity-evidence"
    | "isolation-preflight"
    | "legacy-compose-restore"
    | "reconciliation"
    | "substitute-worker-stop";
}

export interface LegacyRehearsalPlan {
  readonly cleanupCommands: readonly ReleaseCommand[];
  readonly manifest: LegacyRehearsalManifest;
  readonly planHash: string;
  readonly projectName: string;
  readonly steps: readonly LegacyRehearsalStep[];
}

export const rehearsalMigrations = [
  "apps/api/migrations/0001_initial.sql",
  "apps/api/migrations/0002_worker_runtime.sql",
  "apps/api/migrations/0003_queue_inbox.sql",
  "apps/api/migrations/0004_article_retry_safety.sql",
  "apps/api/migrations/0005_operations_readiness.sql",
  "apps/api/migrations/0006_operations_metrics.sql",
  "apps/api/migrations/0007_operations_baselines.sql",
] as const;

const digestPattern = /^ghcr\.nju\.edu\.cn\/[^@]+@sha256:[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const runIdPattern = /^[a-z0-9][a-z0-9-]{5,39}$/;

export function parseLegacyRehearsalManifest(value: unknown): LegacyRehearsalManifest {
  const root = record(value, "manifest");
  exactKeys(root, [
    "assets", "backup", "cloudflare", "d1", "images", "rtoSeconds", "runId",
    "schemaVersion", "sourceCommit",
  ], "manifest");
  if (root.schemaVersion !== 1) throw new Error("manifest.schemaVersion 必须为 1");

  const assets = record(root.assets, "manifest.assets");
  const backup = record(root.backup, "manifest.backup");
  const cloudflare = record(root.cloudflare, "manifest.cloudflare");
  const d1 = record(root.d1, "manifest.d1");
  const images = record(root.images, "manifest.images");
  exactKeys(assets, ["channelsPath", "composePath", "postgresSeedPath"], "manifest.assets");
  exactKeys(backup, ["id", "sha256"], "manifest.backup");
  exactKeys(cloudflare, ["apiPreviousVersion", "consolePreviousCommit"], "manifest.cloudflare");
  exactKeys(d1, ["legacyCutoff", "migrations"], "manifest.d1");
  exactKeys(images, ["mihomo", "warp", "worker"], "manifest.images");

  const parsed = {
    assets: {
      channelsPath: fixedPath(
        assets.channelsPath,
        "deploy/rehearsal/synthetic-channels.yml",
        "assets.channelsPath",
      ),
      composePath: fixedPath(
        assets.composePath,
        "deploy/rehearsal/compose.yml",
        "assets.composePath",
      ),
      postgresSeedPath: fixedPath(
        assets.postgresSeedPath,
        "deploy/rehearsal/postgres-seed.sql",
        "assets.postgresSeedPath",
      ),
    },
    backup: {
      id: text(backup.id, "backup.id"),
      sha256: hash(backup.sha256, "backup.sha256"),
    },
    cloudflare: {
      apiPreviousVersion: text(cloudflare.apiPreviousVersion, "cloudflare.apiPreviousVersion"),
      consolePreviousCommit: commit(
        cloudflare.consolePreviousCommit,
        "cloudflare.consolePreviousCommit",
      ),
    },
    d1: {
      legacyCutoff: fixedPath(
        d1.legacyCutoff,
        "apps/api/migrations/0004_article_retry_safety.sql",
        "d1.legacyCutoff",
      ),
      migrations: migrationList(d1.migrations),
    },
    images: {
      mihomo: imageDigest(images.mihomo, "images.mihomo"),
      warp: imageDigest(images.warp, "images.warp"),
      worker: imageDigest(images.worker, "images.worker"),
    },
    rtoSeconds: rto(root.rtoSeconds),
    runId: runId(root.runId),
    schemaVersion: 1 as const,
    sourceCommit: commit(root.sourceCommit, "sourceCommit"),
  };
  return parsed;
}

export function buildLegacyRehearsalPlan(
  manifest: LegacyRehearsalManifest,
): LegacyRehearsalPlan {
  const projectName = `inbox-rollback-${manifest.runId}`;
  const compose = (args: readonly string[]) => command("docker", [
    "compose", "--project-name", projectName, "--file", manifest.assets.composePath,
    ...args,
  ]);
  const steps: readonly LegacyRehearsalStep[] = [
    step("isolation-preflight", "校验隔离 Compose 并在 RTO 计时前构建旧运行时", [
      compose(["config", "--quiet"]),
      compose(["build", "server", "worker"]),
    ]),
    step("identity-evidence", "读回合成备份、Cloudflare 版本和三容器 digest"),
    step("d1-compatibility", "在本地 SQLite 验证 D1 旧写新读与 migration 幂等"),
    step("substitute-worker-stop", "启动并停止替身新 Worker，从此步骤开始计算 RTO", [
      compose(["up", "-d", "substitute-worker"]),
      compose(["stop", "substitute-worker"]),
    ]),
    step("legacy-compose-restore", "从合成备份启动旧 server/worker 路径并等待健康", [
      compose([
        "up", "-d", "--wait", "--wait-timeout", String(manifest.rtoSeconds),
        "postgres", "redis", "server", "worker",
      ]),
    ]),
    step("reconciliation", "核对 Compose 健康和合成备份标记", [
      compose(["ps", "--format", "json"]),
      compose([
        "exec", "-T", "postgres", "psql", "-U", "inbox", "-d", "inbox", "-Atc",
        "SELECT backup_id || '|' || record_count FROM rehearsal_backup_marker;",
      ]),
    ]),
  ];
  const cleanupCommands = [
    compose(["down", "--volumes", "--remove-orphans"]),
    command("docker", [
      "ps", "-a", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--format", "{{.ID}}",
    ]),
    command("docker", [
      "network", "ls", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--format", "{{.ID}}",
    ]),
    command("docker", [
      "volume", "ls", "--filter", `label=com.docker.compose.project=${projectName}`,
      "--format", "{{.Name}}",
    ]),
  ];
  const planHash = createHash("sha256")
    .update(canonicalJson({ cleanupCommands, manifest, projectName, steps }))
    .digest("hex");
  return { cleanupCommands, manifest, planHash, projectName, steps };
}

function step(
  id: LegacyRehearsalStep["id"],
  description: string,
  commands: readonly ReleaseCommand[] = [],
): LegacyRehearsalStep {
  return { commands, description, id };
}

function command(file: string, args: readonly string[]): ReleaseCommand {
  return { args, file };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} 包含未允许字段: ${unexpected.join(",")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} 必须是非空字符串`);
  }
  return value;
}

function fixedPath<const T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} 必须为 ${expected}`);
  return expected;
}

function commit(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!shaPattern.test(parsed)) throw new Error(`${path} 必须是 40 位提交 SHA`);
  return parsed;
}

function hash(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!sha256Pattern.test(parsed)) throw new Error(`${path} 必须是 64 位 sha256`);
  return parsed;
}

function imageDigest(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!digestPattern.test(parsed)) {
    throw new Error(`${path} 必须使用南京大学 GHCR 代理的 sha256 digest`);
  }
  return parsed;
}

function migrationList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("d1.migrations 必须是字符串数组");
  }
  if (value.length !== rehearsalMigrations.length
    || value.some((item, index) => item !== rehearsalMigrations[index])) {
    throw new Error("d1.migrations 必须精确匹配已审核的 migration 列表");
  }
  return [...value];
}

function rto(value: unknown): number {
  if (value !== 900) throw new Error("rtoSeconds 必须为 900");
  return 900;
}

function runId(value: unknown): string {
  const parsed = text(value, "runId");
  if (!runIdPattern.test(parsed)) throw new Error("runId 必须是 6-40 位小写字母、数字或连字符");
  return parsed;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
