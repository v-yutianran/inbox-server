import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeEvidenceFile } from "./evidence-writer.js";
import type {
  StateKind,
  StateRestorePlan,
  StateRestoreStep,
  StateSnapshotManifest,
} from "./state-restore-plan.js";

interface SnapshotStat {
  readonly mode: number;
  readonly size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface StateRestoreIo {
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<SnapshotStat>;
  mkdir(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  resolveSourcePath(path: string, repositoryRoot: string): string;
  rm(path: string): Promise<void>;
  writeFile(path: string, value: Buffer): Promise<void>;
}

interface SnapshotPayload {
  readonly records: readonly Record<string, unknown>[];
  readonly schemaVersion: 1;
  readonly stableId: string;
  readonly stateKind: StateKind;
}

interface ValidatedSnapshot {
  readonly bytes: Buffer;
  readonly manifest: StateSnapshotManifest;
  readonly payload: SnapshotPayload;
  readonly sha256: string;
}

export interface StateRestoreStateEvidence {
  readonly fileCount: 1;
  readonly mode: "0600";
  readonly reconciled: boolean;
  readonly recordCount: number;
  readonly restoredSha256: string;
  readonly schemaVersion: 1;
  readonly sourceSha256: string;
  readonly stableId: string;
  readonly stateKind: StateKind;
}

export interface StateRestoreStepEvidence {
  readonly description: string;
  readonly event:
    | "operations.state_restore_rehearsal.cleanup_completed"
    | "operations.state_restore_rehearsal.cleanup_failed"
    | "operations.state_restore_rehearsal.step_completed"
    | "operations.state_restore_rehearsal.step_failed"
    | "operations.state_restore_rehearsal.step_planned";
  readonly finishedAt: string;
  readonly id: StateRestoreStep["id"];
  readonly resultSummary: string;
  readonly startedAt: string;
  readonly status: "failed" | "planned" | "succeeded";
}

export interface StateRestoreEvidence {
  readonly candidateRpo: {
    readonly observedMilliseconds: number | null;
    readonly productionStatus: "unapproved";
    readonly status: "candidate_failed" | "candidate_verified" | null;
    readonly targetMilliseconds: 86_400_000;
    readonly withinCandidate: boolean | null;
  };
  readonly counters: {
    readonly commandsExecuted: 0;
    readonly externalCalls: 0;
    readonly productionMutations: 0;
    readonly sensitiveMatches: number;
  };
  readonly dryRun: boolean;
  readonly event:
    | "operations.state_restore_rehearsal.completed"
    | "operations.state_restore_rehearsal.failed"
    | "operations.state_restore_rehearsal.planned";
  readonly planHash: string;
  readonly residuals: { readonly tempDirs: number };
  readonly restoreName: string;
  readonly rpoStatus: "unapproved";
  readonly rtoMilliseconds: number | null;
  readonly runId: string;
  readonly states: readonly StateRestoreStateEvidence[];
  readonly steps: readonly StateRestoreStepEvidence[];
  readonly traceId: "TC-002";
}

export class StateRestoreRehearsalError extends Error {
  constructor(
    message: string,
    public readonly evidence: StateRestoreEvidence,
  ) {
    super(message);
  }
}

export async function writeStateRestoreEvidence(
  path: string,
  value: StateRestoreEvidence,
): Promise<void> {
  await writeEvidenceFile(path, value);
}

export async function executeStateRestoreRehearsal(
  plan: StateRestorePlan,
  options: {
    readonly confirm?: string;
    readonly dryRun: boolean;
    readonly hooks?: { readonly afterRestore?: (root: string) => Promise<void> };
    readonly io?: Partial<StateRestoreIo>;
    readonly now?: () => Date;
    readonly repositoryRoot?: string;
  },
): Promise<StateRestoreEvidence> {
  const now = options.now ?? (() => new Date());
  if (options.dryRun) return plannedEvidence(plan, now());
  if (options.confirm !== plan.planHash) {
    throw new Error("实际状态恢复演练必须用 --confirm 提供同一份计划的 planHash");
  }

  const io = stateRestoreIo(options.io);
  const repositoryRoot = resolve(options.repositoryRoot ?? fileURLToPath(
    new URL("../../../", import.meta.url),
  ));
  const records: StateRestoreStepEvidence[] = [];
  const states: StateRestoreStateEvidence[] = [];
  let activeStep: StateRestoreStep | undefined;
  let candidateObserved: number | null = null;
  let failure: unknown;
  let restoreRoot: string | undefined;
  let restoreStartedAt: number | null = null;
  let rtoMilliseconds: number | null = null;

  try {
    activeStep = step(plan, "snapshot-preflight");
    const startedAt = now();
    const snapshots = await Promise.all(plan.manifest.snapshots.map((snapshot) =>
      validateSourceSnapshot(snapshot, repositoryRoot, io)));
    const restoreBoundary = now();
    candidateObserved = restoreBoundary.getTime() - new Date(plan.manifest.capturedAt).getTime();
    if (candidateObserved < 0 || candidateObserved > 86_400_000) {
      throw new Error("候选 RPO 窗口不满足 24 小时限制");
    }
    records.push(completed(activeStep, startedAt, restoreBoundary, "three fixed snapshots verified"));

    activeStep = step(plan, "restore");
    const restoreStarted = restoreBoundary;
    restoreStartedAt = restoreStarted.getTime();
    restoreRoot = await io.mkdtemp(join(tmpdir(), `${plan.restoreName}-`));
    for (const snapshot of snapshots) {
      const destinationRoot = join(restoreRoot, snapshot.manifest.stateKind);
      await io.mkdir(destinationRoot);
      const destination = join(destinationRoot, "state.json");
      await io.writeFile(destination, snapshot.bytes);
      await io.chmod(destination, 0o600);
    }
    records.push(completed(activeStep, restoreStarted, now(), "three synthetic states restored"));

    activeStep = step(plan, "startup-gate");
    const startupStarted = now();
    await options.hooks?.afterRestore?.(restoreRoot);
    for (const snapshot of snapshots) {
      states.push(await validateRestoredSnapshot(snapshot, restoreRoot, io));
    }
    records.push(completed(activeStep, startupStarted, now(), "synthetic startup gate passed"));

    activeStep = step(plan, "reconciliation");
    const reconciliationStarted = now();
    if (states.length !== plan.manifest.snapshots.length || states.some(({ reconciled }) => !reconciled)) {
      throw new Error("恢复状态对账失败");
    }
    rtoMilliseconds = now().getTime() - restoreStartedAt;
    if (rtoMilliseconds > 900_000) throw new Error("隔离恢复 RTO 超过 15 分钟");
    records.push(completed(activeStep, reconciliationStarted, now(), "all state identities reconciled"));
  } catch (error: unknown) {
    failure = error;
    if (activeStep) records.push(failed(activeStep, now(), safeSummary(error)));
  }

  const cleanup = await cleanupRestore(plan, restoreRoot, io, now);
  records.push(cleanup.record);
  if (!failure && cleanup.failure) failure = cleanup.failure;
  const finalEvidence = evidence(plan, {
    candidateObserved,
    dryRun: false,
    event: failure
      ? "operations.state_restore_rehearsal.failed"
      : "operations.state_restore_rehearsal.completed",
    residuals: cleanup.residuals,
    rtoMilliseconds,
    states,
    steps: records,
  });
  if (failure) {
    throw new StateRestoreRehearsalError(
      `隔离状态恢复演练失败: ${safeSummary(failure)}`,
      finalEvidence,
    );
  }
  return finalEvidence;
}

function stateRestoreIo(overrides: Partial<StateRestoreIo> = {}): StateRestoreIo {
  return {
    chmod,
    lstat,
    mkdir: async (path) => {
      await mkdir(path, { mode: 0o700, recursive: false });
    },
    mkdtemp,
    readFile,
    resolveSourcePath: (path, repositoryRoot) => resolve(repositoryRoot, path),
    rm: async (path) => {
      await rm(path, { force: true, recursive: true });
    },
    writeFile: async (path, value) => {
      await writeFile(path, value, { flag: "wx", mode: 0o600 });
    },
    ...overrides,
  };
}

async function validateSourceSnapshot(
  manifest: StateSnapshotManifest,
  repositoryRoot: string,
  io: StateRestoreIo,
): Promise<ValidatedSnapshot> {
  const path = io.resolveSourcePath(manifest.path, repositoryRoot);
  const stat = await io.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("快照必须是普通文件且禁止符号链接");
  if (stat.size > 65_536) throw new Error("快照超过 64 KiB 限制");
  const bytes = await io.readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== manifest.sha256) throw new Error("合成快照 sha256 与 manifest 不一致");
  const payload = parseSnapshot(bytes, manifest.stateKind);
  assertSnapshotIdentity(payload, manifest);
  return { bytes, manifest, payload, sha256 };
}

async function validateRestoredSnapshot(
  source: ValidatedSnapshot,
  restoreRoot: string,
  io: StateRestoreIo,
): Promise<StateRestoreStateEvidence> {
  const path = join(restoreRoot, source.manifest.stateKind, "state.json");
  const stat = await io.lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("恢复目标必须是普通文件");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("恢复目标权限必须为 0600");
  const bytes = await io.readFile(path);
  const restoredSha256 = createHash("sha256").update(bytes).digest("hex");
  const payload = parseSnapshot(bytes, source.manifest.stateKind);
  assertSnapshotIdentity(payload, source.manifest);
  const reconciled = restoredSha256 === source.sha256;
  if (!reconciled) throw new Error("恢复目标摘要与源快照不一致");
  return {
    fileCount: 1,
    mode: "0600",
    reconciled,
    recordCount: payload.records.length,
    restoredSha256,
    schemaVersion: 1,
    sourceSha256: source.sha256,
    stableId: payload.stableId,
    stateKind: payload.stateKind,
  };
}

function parseSnapshot(bytes: Buffer, expectedKind: StateKind): SnapshotPayload {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("快照不是有效 JSON");
  }
  const root = record(value, "snapshot");
  exactKeys(root, ["records", "schemaVersion", "stableId", "stateKind"], "snapshot");
  if (root.schemaVersion !== 1) throw new Error("snapshot.schemaVersion 必须为 1");
  if (root.stateKind !== expectedKind) throw new Error("snapshot.stateKind 与 manifest 不一致");
  if (typeof root.stableId !== "string" || root.stableId === "") {
    throw new Error("snapshot.stableId 必须是非空字符串");
  }
  if (!Array.isArray(root.records)) throw new Error("snapshot.records 必须是数组");
  const records = root.records.map((item, index) => parseRecord(expectedKind, item, index));
  if (sensitiveMatches(bytes.toString("utf8")) !== 0) throw new Error("合成快照包含敏感模式");
  return { records, schemaVersion: 1, stableId: root.stableId, stateKind: expectedKind };
}

function parseRecord(kind: StateKind, value: unknown, index: number): Record<string, unknown> {
  const item = record(value, `snapshot.records[${index}]`);
  const schemas: Record<StateKind, readonly string[]> = {
    browser: ["authenticated", "profile"],
    warp: ["registrationId", "status"],
    worker: ["key", "status"],
  };
  exactKeys(item, schemas[kind], `snapshot.records[${index}]`);
  if (kind === "browser") {
    if (item.authenticated !== false || typeof item.profile !== "string") {
      throw new Error("browser 合成记录格式无效");
    }
  } else if (kind === "warp") {
    if (typeof item.registrationId !== "string" || item.status !== "registered") {
      throw new Error("warp 合成记录格式无效");
    }
  } else if (typeof item.key !== "string" || item.status !== "ready") {
    throw new Error("worker 合成记录格式无效");
  }
  return item;
}

function assertSnapshotIdentity(
  payload: SnapshotPayload,
  manifest: StateSnapshotManifest,
): void {
  if (payload.schemaVersion !== manifest.schemaVersion
    || payload.stateKind !== manifest.stateKind
    || payload.stableId !== manifest.stableId
    || payload.records.length !== manifest.recordCount) {
    throw new Error("快照 schema、类别、稳定标识或记录数与 manifest 不一致");
  }
}

async function cleanupRestore(
  plan: StateRestorePlan,
  restoreRoot: string | undefined,
  io: StateRestoreIo,
  now: () => Date,
): Promise<{
  readonly failure: unknown;
  readonly record: StateRestoreStepEvidence;
  readonly residuals: { readonly tempDirs: number };
}> {
  const cleanupStep = step(plan, "cleanup");
  const startedAt = now();
  let failure: unknown;
  if (restoreRoot) {
    try {
      await io.rm(restoreRoot);
    } catch (error: unknown) {
      failure = error;
    }
  }
  const tempDirs = restoreRoot && await exists(restoreRoot, io) ? 1 : 0;
  if (tempDirs !== 0 && !failure) failure = new Error("临时恢复目录未清理");
  return {
    failure,
    record: {
      description: cleanupStep.description,
      event: failure
        ? "operations.state_restore_rehearsal.cleanup_failed"
        : "operations.state_restore_rehearsal.cleanup_completed",
      finishedAt: now().toISOString(),
      id: "cleanup",
      resultSummary: failure ? safeSummary(failure) : "temporary restore directory removed",
      startedAt: startedAt.toISOString(),
      status: failure ? "failed" : "succeeded",
    },
    residuals: { tempDirs },
  };
}

function plannedEvidence(plan: StateRestorePlan, at: Date): StateRestoreEvidence {
  return evidence(plan, {
    candidateObserved: null,
    dryRun: true,
    event: "operations.state_restore_rehearsal.planned",
    residuals: { tempDirs: 0 },
    rtoMilliseconds: null,
    states: [],
    steps: plan.steps.map((value) => ({
      description: value.description,
      event: "operations.state_restore_rehearsal.step_planned",
      finishedAt: at.toISOString(),
      id: value.id,
      resultSummary: "dry-run: zero filesystem and external side effects",
      startedAt: at.toISOString(),
      status: "planned",
    })),
  });
}

function evidence(
  plan: StateRestorePlan,
  input: {
    readonly candidateObserved: number | null;
    readonly dryRun: boolean;
    readonly event: StateRestoreEvidence["event"];
    readonly residuals: StateRestoreEvidence["residuals"];
    readonly rtoMilliseconds: number | null;
    readonly states: readonly StateRestoreStateEvidence[];
    readonly steps: readonly StateRestoreStepEvidence[];
  },
): StateRestoreEvidence {
  const serialized = JSON.stringify({ ...input, manifest: plan.manifest });
  const withinCandidate = input.candidateObserved === null
    ? null
    : input.candidateObserved >= 0 && input.candidateObserved <= 86_400_000;
  return {
    candidateRpo: {
      observedMilliseconds: input.candidateObserved,
      productionStatus: "unapproved",
      status: withinCandidate === null
        ? null
        : withinCandidate ? "candidate_verified" : "candidate_failed",
      targetMilliseconds: 86_400_000,
      withinCandidate,
    },
    counters: {
      commandsExecuted: 0,
      externalCalls: 0,
      productionMutations: 0,
      sensitiveMatches: sensitiveMatches(serialized),
    },
    dryRun: input.dryRun,
    event: input.event,
    planHash: plan.planHash,
    residuals: input.residuals,
    restoreName: plan.restoreName,
    rpoStatus: "unapproved",
    rtoMilliseconds: input.rtoMilliseconds,
    runId: plan.manifest.runId,
    states: input.states,
    steps: input.steps,
    traceId: "TC-002",
  };
}

function completed(
  value: StateRestoreStep,
  startedAt: Date,
  finishedAt: Date,
  resultSummary: string,
): StateRestoreStepEvidence {
  return {
    description: value.description,
    event: "operations.state_restore_rehearsal.step_completed",
    finishedAt: finishedAt.toISOString(),
    id: value.id,
    resultSummary,
    startedAt: startedAt.toISOString(),
    status: "succeeded",
  };
}

function failed(value: StateRestoreStep, at: Date, error: unknown): StateRestoreStepEvidence {
  return {
    description: value.description,
    event: "operations.state_restore_rehearsal.step_failed",
    finishedAt: at.toISOString(),
    id: value.id,
    resultSummary: safeSummary(error),
    startedAt: at.toISOString(),
    status: "failed",
  };
}

function step(plan: StateRestorePlan, id: StateRestoreStep["id"]): StateRestoreStep {
  const value = plan.steps.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`计划缺少 ${id} 步骤`);
  return value;
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
  if (unexpected.length > 0 || missing.length > 0) throw new Error(`${path} 字段不符合固定 schema`);
}

function sensitiveMatches(value: string): number {
  const patterns = [
    /https?:\/\//gi,
    /(?:authorization|cookie|password|secret|token)\s*[=:]/gi,
  ];
  return patterns.reduce((count, pattern) => count + (value.match(pattern)?.length ?? 0), 0);
}

function safeSummary(error: unknown): string {
  const value = error instanceof Error ? error.message : "unknown error";
  return value
    .replace(/(?:authorization|cookie|password|secret|token)\s*[=:]\s*(?:Bearer\s+)?[^\s,;]+/gi, "[credential]")
    .replace(/https?:\/\/[^\s]+/g, "[url]")
    .replace(/\/(?:Users|private\/tmp|tmp|var)\/[^\s:]+/g, "[path]")
    .trim()
    .slice(0, 500);
}

async function exists(path: string, io: StateRestoreIo): Promise<boolean> {
  try {
    await io.lstat(path);
    return true;
  } catch {
    return false;
  }
}
