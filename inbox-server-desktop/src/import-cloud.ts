import { randomUUID } from "node:crypto";

import type { DispatchItem, ItemKind } from "./domain.ts";
import { createItemDedupeKey, isHttpUrl, planQueueBatches } from "./domain.ts";
import type { CloudHistoryRow, InboxStore } from "./store.ts";

export interface ImportSummary {
  format: "inbox-cloud-export-v1";
  articleEvents: number;
  stateKeys: number;
  cloudJobs: number;
  requeued: number;
  skippedEncryptedEnvelopes: number;
  syncJobs: number;
}

const REQUEUEABLE = new Set(["processing", "deferred", "failed", "queued"]);

/** 导入 Neon / D1 导出的明文 JSON。密文信封无法在没有云端密钥时还原，只计数。 */
export function importCloudExport(store: InboxStore, input: unknown, now = new Date()): ImportSummary {
  if (!isRecord(input) || input.format !== "inbox-cloud-export-v1") {
    throw new Error("需要 format = inbox-cloud-export-v1 的导出文件");
  }
  const summary: ImportSummary = {
    format: "inbox-cloud-export-v1",
    articleEvents: 0,
    stateKeys: 0,
    cloudJobs: 0,
    requeued: 0,
    skippedEncryptedEnvelopes: countEncrypted(input),
    syncJobs: 0,
  };
  const timestamp = now.toISOString();

  for (const event of asArray(input.articleArchiveEvents ?? input.article_archive_events)) {
    if (!isRecord(event)) continue;
    const sourceUrl = text(event, "sourceUrl", "source_url");
    const occurredAt = text(event, "occurredAt", "occurred_at");
    const status = text(event, "status", "status");
    if (!sourceUrl || !occurredAt || !status) continue;
    const inserted = store.recordArticleEvent({
      sourceUrl,
      urlFingerprint: text(event, "urlFingerprint", "url_fingerprint") || createItemDedupeKey({
        itemKind: "article",
        requestedAt: timestamp,
        url: sourceUrl,
      }),
      title: text(event, "title", "title"),
      status,
      reason: optionalText(event, "reason", "reason"),
      filename: optionalText(event, "filename", "filename"),
      occurredAt,
    });
    if (inserted) summary.articleEvents += 1;
  }

  for (const row of asArray(input.workerState ?? input.worker_state)) {
    if (!isRecord(row)) continue;
    const key = text(row, "key", "key");
    if (!key) continue;
    const value = row.value ?? row.value_json ?? {};
    store.putState(key, typeof value === "string" ? parseJson(value) : value, text(row, "updatedAt", "updated_at") || timestamp);
    summary.stateKeys += 1;
  }

  for (const row of asArray(input.baselines ?? input.incremental_baselines)) {
    if (!isRecord(row)) continue;
    const source = text(row, "source", "source");
    if (!source) continue;
    const known = row.knownKeys ?? row.known_keys ?? [];
    store.putState(`baseline:${source}`, { knownKeys: Array.isArray(known) ? known : parseJson(String(known)) }, timestamp);
    summary.stateKeys += 1;
  }

  for (const row of asArray(input.syncJobs ?? input.sync_jobs)) {
    if (!isRecord(row)) continue;
    const id = text(row, "id", "id");
    const startedAt = text(row, "startedAt", "started_at");
    if (!id || !startedAt) continue;
    store.startSyncJob(id, text(row, "triggeredBy", "triggered_by") || "import", startedAt);
    store.finishSyncJob(
      id,
      text(row, "status", "status") || "done",
      row.stats ?? {},
      text(row, "finishedAt", "finished_at") || startedAt,
      optionalText(row, "error", "error"),
    );
    summary.syncJobs += 1;
  }

  const requeue: Array<{ payload: DispatchItem; source: string }> = [];
  for (const row of asArray(input.jobs ?? input.worker_jobs)) {
    if (!isRecord(row)) continue;
    const dedupeKey = text(row, "dedupeKey", "dedupe_key");
    const jobId = text(row, "jobId", "job_id");
    if (!dedupeKey || !jobId) continue;
    const history: CloudHistoryRow = {
      dedupeKey,
      jobId,
      kind: text(row, "kind", "kind") || "dispatch-item",
      itemKind: optionalText(row, "itemKind", "item_kind"),
      status: text(row, "status", "status") || "uncertain",
      errorMessage: optionalText(row, "errorMessage", "error_message"),
      createdAt: text(row, "createdAt", "created_at") || timestamp,
      finishedAt: optionalText(row, "finishedAt", "finished_at"),
    };
    store.upsertCloudHistory(history);
    summary.cloudJobs += 1;
    const payload = normalizePayload(row.payload);
    if (payload && REQUEUEABLE.has(history.status)) {
      requeue.push({ payload, source: "import" });
    }
  }

  if (requeue.length > 0) {
    const jobs = requeue.map((entry) => ({
      job: {
        id: randomUUID(),
        dedupeKey: createItemDedupeKey(entry.payload),
        payload: entry.payload,
        createdAt: timestamp,
      },
      source: entry.source,
    }));
    planQueueBatches(jobs.map((entry) => entry.job));
    summary.requeued = store.publishJobs(jobs).published;
  }

  store.recordImport(randomUUID(), timestamp, summary);
  return summary;
}

function countEncrypted(input: Record<string, unknown>): number {
  if (typeof input.skippedEncryptedEnvelopes === "number") return input.skippedEncryptedEnvelopes;
  if (typeof input.encryptedEnvelopeCount === "number") return input.encryptedEnvelopeCount;
  const envelopes = asArray(input.workerJobEnvelopes ?? input.worker_job_envelopes);
  return envelopes.length;
}

function normalizePayload(value: unknown): DispatchItem | null {
  const payload = isRecord(value) ? value : null;
  if (!payload || typeof payload.itemKind !== "string") return null;
  const kind = payload.itemKind as ItemKind;
  if (kind === "link" || kind === "article") {
    const url = typeof payload.url === "string" ? payload.url : "";
    if (!isHttpUrl(url)) return null;
    if (kind === "article") {
      return {
        itemKind: "article",
        url,
        title: typeof payload.title === "string" ? payload.title : undefined,
        tags: stringList(payload.tags),
        requestedAt: typeof payload.requestedAt === "string" ? payload.requestedAt : new Date().toISOString(),
      };
    }
    return {
      itemKind: "link",
      url,
      title: typeof payload.title === "string" ? payload.title : undefined,
      tags: stringList(payload.tags),
    };
  }
  if (kind === "text" && typeof payload.content === "string" && payload.content.length > 0) {
    return { itemKind: "text", content: payload.content, tags: stringList(payload.tags) };
  }
  if (kind === "file" && typeof payload.remoteName === "string") {
    const localPath = typeof payload.localPath === "string" ? payload.localPath : undefined;
    const objectKey = typeof payload.objectKey === "string" ? payload.objectKey : undefined;
    if (Boolean(localPath) === Boolean(objectKey)) return null;
    return { itemKind: "file", remoteName: payload.remoteName, localPath, objectKey };
  }
  return null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return tags.length > 0 ? tags : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(row: Record<string, unknown>, camel: string, snake: string): string {
  const value = row[camel] ?? row[snake];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function optionalText(row: Record<string, unknown>, camel: string, snake: string): string | null {
  const value = text(row, camel, snake);
  return value.length > 0 ? value : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
