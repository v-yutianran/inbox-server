import { createHash } from "node:crypto";

export type StateKind = "worker" | "browser" | "warp";

export interface StateSnapshotManifest {
  readonly fileCount: 1;
  readonly path: string;
  readonly recordCount: number;
  readonly schemaVersion: 1;
  readonly sha256: string;
  readonly snapshotId: string;
  readonly stableId: string;
  readonly stateKind: StateKind;
}

export interface StateRestoreManifest {
  readonly candidateRpoSeconds: 86_400;
  readonly capturedAt: string;
  readonly rpoStatus: "unapproved";
  readonly runId: string;
  readonly schemaVersion: 1;
  readonly snapshots: readonly StateSnapshotManifest[];
  readonly sourceCommit: string;
}

export interface StateRestoreStep {
  readonly description: string;
  readonly id:
    | "snapshot-preflight"
    | "restore"
    | "startup-gate"
    | "reconciliation"
    | "cleanup";
}

export interface StateRestorePlan {
  readonly manifest: StateRestoreManifest;
  readonly planHash: string;
  readonly restoreName: string;
  readonly steps: readonly StateRestoreStep[];
}

export const stateSnapshotPaths: Readonly<Record<StateKind, string>> = {
  browser: "deploy/rehearsal/state-snapshots/browser/state.json",
  warp: "deploy/rehearsal/state-snapshots/warp/state.json",
  worker: "deploy/rehearsal/state-snapshots/worker/state.json",
};

const stateKinds = ["worker", "browser", "warp"] as const;
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{5,63}$/;

export function parseStateRestoreManifest(value: unknown): StateRestoreManifest {
  const root = record(value, "manifest");
  exactKeys(root, [
    "candidateRpoSeconds",
    "capturedAt",
    "rpoStatus",
    "runId",
    "schemaVersion",
    "snapshots",
    "sourceCommit",
  ], "manifest");
  if (root.schemaVersion !== 1) throw new Error("manifest.schemaVersion 必须为 1");
  if (root.candidateRpoSeconds !== 86_400) {
    throw new Error("candidateRpoSeconds 必须为 86400");
  }
  if (root.rpoStatus !== "unapproved") throw new Error("rpoStatus 必须为 unapproved");
  if (!Array.isArray(root.snapshots) || root.snapshots.length !== stateKinds.length) {
    throw new Error("snapshots 必须精确包含 Worker、浏览器和 WARP 三类快照");
  }
  const snapshots = root.snapshots.map(parseSnapshotManifest);
  snapshots.forEach((snapshot, index) => {
    if (snapshot.stateKind !== stateKinds[index]) {
      throw new Error("snapshots 必须按 worker、browser、warp 顺序且不得重复");
    }
  });
  return {
    candidateRpoSeconds: 86_400,
    capturedAt: timestamp(root.capturedAt),
    rpoStatus: "unapproved",
    runId: identifier(root.runId, "runId"),
    schemaVersion: 1,
    snapshots,
    sourceCommit: commit(root.sourceCommit),
  };
}

export function buildStateRestorePlan(manifest: StateRestoreManifest): StateRestorePlan {
  const restoreName = `inbox-state-restore-${manifest.runId}`;
  const steps: readonly StateRestoreStep[] = [
    { id: "snapshot-preflight", description: "在创建恢复目录前验证固定快照、摘要与候选 RPO" },
    { id: "restore", description: "把三类合成状态恢复到唯一临时目录并设置 0600 权限" },
    { id: "startup-gate", description: "重新读取三类状态并执行不启动真实进程的合成启动门禁" },
    { id: "reconciliation", description: "对账摘要、schema、稳定标识、文件数和记录数" },
    { id: "cleanup", description: "无论成功或失败都清理临时恢复目录" },
  ];
  const planHash = createHash("sha256")
    .update(canonicalJson({ manifest, restoreName, steps }))
    .digest("hex");
  return { manifest, planHash, restoreName, steps };
}

function parseSnapshotManifest(value: unknown, index: number): StateSnapshotManifest {
  const path = `manifest.snapshots[${index}]`;
  const item = record(value, path);
  exactKeys(item, [
    "fileCount",
    "path",
    "recordCount",
    "schemaVersion",
    "sha256",
    "snapshotId",
    "stableId",
    "stateKind",
  ], path);
  const stateKind = kind(item.stateKind, `${path}.stateKind`);
  if (item.path !== stateSnapshotPaths[stateKind]) {
    throw new Error(`${path}.path 必须为已审核的固定合成快照路径`);
  }
  if (item.fileCount !== 1) throw new Error(`${path}.fileCount 必须为 1`);
  if (item.schemaVersion !== 1) throw new Error(`${path}.schemaVersion 必须为 1`);
  if (!Number.isSafeInteger(item.recordCount) || (item.recordCount as number) < 0) {
    throw new Error(`${path}.recordCount 必须为非负安全整数`);
  }
  return {
    fileCount: 1,
    path: stateSnapshotPaths[stateKind],
    recordCount: item.recordCount as number,
    schemaVersion: 1,
    sha256: hash(item.sha256, `${path}.sha256`),
    snapshotId: identifier(item.snapshotId, `${path}.snapshotId`),
    stableId: identifier(item.stableId, `${path}.stableId`),
    stateKind,
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !actual.includes(key));
  if (unexpected.length > 0) throw new Error(`${path} 包含未允许字段: ${unexpected.join(",")}`);
  if (missing.length > 0) throw new Error(`${path} 缺少字段: ${missing.join(",")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} 必须是非空字符串`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!idPattern.test(parsed)) throw new Error(`${path} 格式无效`);
  return parsed;
}

function kind(value: unknown, path: string): StateKind {
  if (value !== "worker" && value !== "browser" && value !== "warp") {
    throw new Error(`${path} 必须为 worker、browser 或 warp`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!hashPattern.test(parsed)) throw new Error(`${path} 必须是 64 位 sha256`);
  return parsed;
}

function commit(value: unknown): string {
  const parsed = text(value, "sourceCommit");
  if (!commitPattern.test(parsed)) throw new Error("sourceCommit 必须是 40 位提交 SHA");
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = text(value, "capturedAt");
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed) {
    throw new Error("capturedAt 必须是规范 ISO-8601 UTC 时间");
  }
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
