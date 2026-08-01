import { parseQueueJob, type QueueJob } from "@inbox/domain";

import type { ApiBindings } from "./auth.js";
import { decideJobSettlement, type JobErrorClass } from "./control-plane-contract.js";
import { decryptJson, encryptJson } from "./credential-crypto.js";
import { advanceSyncJob } from "./operations.js";
import { createQueueProducer, type QueueProducer } from "./queue-producer.js";

const ITEM_KINDS = ["link", "text", "file", "article"] as const;
type ItemKind = (typeof ITEM_KINDS)[number];

type JsonRecord = Readonly<Record<string, unknown>>;

export interface JobResultInput {
  readonly errorClass?: JobErrorClass;
  readonly errorMessage?: string;
  readonly payloadDigest?: string;
  readonly status: "done" | "failed";
  readonly summary?: JsonRecord;
}

export interface ControlPlaneService {
  claimEffect(input: {
    readonly destination: string;
    readonly effectKey: string;
    readonly jobId: string;
  }): Promise<{ readonly attempts?: number; readonly state: "busy" | "claimed" | "done" | "uncertain" }>;
  claimJob(job: QueueJob): Promise<{
    readonly attempts?: number;
    readonly state: "busy" | "claimed" | "duplicate";
  }>;
  consumeRateLimit(input: {
    readonly bucketKey: string;
    readonly limit: number;
    readonly scope: string;
    readonly windowSeconds: number;
  }): Promise<{ readonly allowed: boolean; readonly count: number; readonly retryAt?: string }>;
  finishEffect(
    effectKey: string,
    input: {
      readonly errorClass?: JobErrorClass;
      readonly errorMessage?: string;
      readonly status: "done" | "failed" | "uncertain";
    },
  ): Promise<void>;
  finishJob(jobId: string, input: JobResultInput): Promise<{
    readonly delaySeconds?: number;
    readonly settlement: "ack" | "retry";
  }>;
  getChannels(): Promise<JsonRecord>;
  getCredential(name: string): Promise<unknown | null>;
  getLoginStatus(platform: string): Promise<JsonRecord>;
  getQueueDlq(): Promise<JsonRecord>;
  getQueueSummary(): Promise<JsonRecord>;
  getState(key: string): Promise<unknown | null>;
  publishJobs(jobs: readonly QueueJob[]): Promise<{ readonly queued: number }>;
  putLoginSession(
    platform: string,
    input: {
      readonly expiresAt: string;
      readonly lastError?: string | null;
      readonly state: unknown;
      readonly status: string;
    },
  ): Promise<void>;
  putState(key: string, value: unknown): Promise<void>;
  recordArticleEvent(event: {
    readonly filename: string | null;
    readonly reason: string | null;
    readonly sourceUrl: string;
    readonly status: string;
    readonly title: string;
    readonly urlFingerprint: string;
  }): Promise<void>;
  recordHeartbeat(workerId: string, details: JsonRecord): Promise<void>;
  rejectInvalidJob(input: {
    readonly attempts: number;
    readonly messageId: string;
    readonly payloadDigest: string;
    readonly reason: string;
  }): Promise<void>;
  writeCookie(platform: string, payload: JsonRecord): Promise<JsonRecord>;
}

interface ControlPlaneOptions {
  readonly database: D1Database;
  readonly encryptionKey: string;
  readonly now?: () => Date;
  readonly producer: QueueProducer;
}

interface WorkerJobRow {
  readonly attempts: number;
  readonly created_at: string;
  readonly dedupe_key: string;
  readonly item_kind: ItemKind | null;
  readonly job_id: string;
  readonly kind: string;
  readonly status: "processing" | "done" | "failed" | "dead";
  readonly updated_at: string;
}

interface WorkerEffectRow {
  readonly attempts: number;
  readonly status: "processing" | "done" | "failed" | "uncertain";
  readonly updated_at: string;
}

export function createControlPlaneServiceFromBindings(
  bindings: ApiBindings,
): ControlPlaneService {
  return createD1ControlPlaneService({
    database: bindings.DB,
    encryptionKey: bindings.STATE_ENCRYPTION_KEY ?? "",
    producer: createQueueProducer(bindings.JOBS),
  });
}

export function createD1ControlPlaneService({
  database,
  encryptionKey,
  now = () => new Date(),
  producer,
}: ControlPlaneOptions): ControlPlaneService {
  const nowIso = () => now().toISOString();

  async function getState(key: string): Promise<unknown | null> {
    const row = await database
      .prepare("SELECT value FROM worker_state WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row ? JSON.parse(row.value) : null;
  }

  async function putState(key: string, value: unknown): Promise<void> {
    await database
      .prepare(
        `INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, JSON.stringify(value), nowIso())
      .run();
  }

  async function prepareSyncJobCompletion(
    row: WorkerJobRow,
    input: JobResultInput,
    terminalStatus: "done" | "failed",
    timestamp: string,
  ): Promise<D1PreparedStatement | null> {
    if (row.kind !== "collect-source") return null;
    const match = /^collect:([^:]+):(.+)$/.exec(row.dedupe_key);
    if (!match) return null;
    const source = match[1];
    const runId = match[2];
    if (!source || !runId) return null;
    const syncJob = await database
      .prepare("SELECT stats FROM sync_jobs WHERE id = ?")
      .bind(runId)
      .first<{ stats: string }>();
    if (!syncJob) return null;
    const next = advanceSyncJob(JSON.parse(syncJob.stats) as Record<string, unknown>, {
      ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 500) } : {}),
      finishedAt: timestamp,
      source,
      status: terminalStatus,
      ...(input.summary ? { summary: input.summary } : {}),
    });
    return database
      .prepare(
        `UPDATE sync_jobs SET stats = ?, status = ?, error = ?, finished_at = ? WHERE id = ?`,
      )
      .bind(JSON.stringify(next.stats), next.status, next.error, next.finishedAt, runId);
  }

  return {
    async claimEffect(input) {
      const existing = await database
        .prepare(
          "SELECT attempts, status, updated_at FROM worker_effects WHERE effect_key = ?",
        )
        .bind(input.effectKey)
        .first<WorkerEffectRow>();
      if (existing?.status === "done") return { state: "done" };
      if (existing?.status === "uncertain") return { state: "uncertain" };
      if (existing?.status === "processing" && !isStale(existing.updated_at, now())) {
        return { state: "busy" };
      }
      const timestamp = nowIso();
      if (existing) {
        const attempts = existing.attempts + 1;
        await database
          .prepare(
            `UPDATE worker_effects
             SET attempts = ?, status = 'processing', error_class = NULL,
                 error_message = NULL, updated_at = ?, finished_at = NULL
             WHERE effect_key = ?`,
          )
          .bind(attempts, timestamp, input.effectKey)
          .run();
        return { attempts, state: "claimed" };
      }
      await database
        .prepare(
          `INSERT INTO worker_effects
           (effect_key, job_id, destination, status, attempts, updated_at)
           VALUES (?, ?, ?, 'processing', 1, ?)`,
        )
        .bind(input.effectKey, input.jobId, input.destination, timestamp)
        .run();
      return { attempts: 1, state: "claimed" };
    },

    async claimJob(input) {
      const job = parseQueueJob(input);
      const existing = await database
        .prepare(
          `SELECT attempts, created_at, dedupe_key, item_kind, job_id, kind, status, updated_at
           FROM worker_jobs WHERE dedupe_key = ?`,
        )
        .bind(job.dedupeKey)
        .first<WorkerJobRow>();
      if (existing?.status === "done" || existing?.status === "dead") {
        return { state: "duplicate" };
      }
      if (existing?.status === "processing" && !isStale(existing.updated_at, now())) {
        return { state: "busy" };
      }
      const timestamp = nowIso();
      if (existing) {
        const attempts = existing.attempts + 1;
        await database
          .prepare(
            `UPDATE worker_jobs
             SET attempts = ?, job_id = ?, status = 'processing', updated_at = ?,
                 error_class = NULL, error_message = NULL, finished_at = NULL
             WHERE dedupe_key = ?`,
          )
          .bind(attempts, job.jobId, timestamp, job.dedupeKey)
          .run();
        return { attempts, state: "claimed" };
      }
      const itemKind = job.kind === "dispatch-item" ? job.payload.itemKind : null;
      await database
        .prepare(
          `INSERT INTO worker_jobs
           (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'processing', 1, ?, ?)`,
        )
        .bind(job.dedupeKey, job.jobId, job.kind, itemKind, job.createdAt, timestamp)
        .run();
      return { attempts: 1, state: "claimed" };
    },

    async consumeRateLimit(input) {
      const current = await database
        .prepare(
          `SELECT count, expires_at FROM worker_rate_limits
           WHERE scope = ? AND bucket_key = ?`,
        )
        .bind(input.scope, input.bucketKey)
        .first<{ count: number; expires_at: string }>();
      const currentTime = now();
      if (!current || Date.parse(current.expires_at) <= currentTime.getTime()) {
        const expiresAt = new Date(
          currentTime.getTime() + input.windowSeconds * 1_000,
        ).toISOString();
        await database
          .prepare(
            `INSERT INTO worker_rate_limits
             (scope, bucket_key, count, expires_at, updated_at) VALUES (?, ?, 1, ?, ?)
             ON CONFLICT(scope, bucket_key) DO UPDATE SET
               count = 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
          )
          .bind(input.scope, input.bucketKey, expiresAt, nowIso())
          .run();
        return { allowed: true, count: 1 };
      }
      if (current.count >= input.limit) {
        return { allowed: false, count: current.count, retryAt: current.expires_at };
      }
      const count = current.count + 1;
      await database
        .prepare(
          `UPDATE worker_rate_limits SET count = ?, updated_at = ?
           WHERE scope = ? AND bucket_key = ?`,
        )
        .bind(count, nowIso(), input.scope, input.bucketKey)
        .run();
      return { allowed: true, count };
    },

    async finishEffect(effectKey, input) {
      await database
        .prepare(
          `UPDATE worker_effects SET status = ?, error_class = ?, error_message = ?,
           updated_at = ?, finished_at = ? WHERE effect_key = ?`,
        )
        .bind(
          input.status,
          input.errorClass ?? null,
          input.errorMessage?.slice(0, 500) ?? null,
          nowIso(),
          input.status === "failed" ? null : nowIso(),
          effectKey,
        )
        .run();
    },

    async finishJob(jobId, input) {
      const row = await database
        .prepare(
          `SELECT attempts, created_at, dedupe_key, item_kind, job_id, kind, status, updated_at
           FROM worker_jobs WHERE job_id = ?`,
        )
        .bind(jobId)
        .first<WorkerJobRow>();
      if (!row) throw new Error("job claim not found");
      if (row.status === "done" || row.status === "dead") return { settlement: "ack" };
      const timestamp = nowIso();
      if (input.status === "done") {
        const workerUpdate = database
          .prepare(
            `UPDATE worker_jobs SET status = 'done', summary = ?, updated_at = ?,
             finished_at = ?, error_class = NULL, error_message = NULL WHERE job_id = ?`,
          )
          .bind(JSON.stringify(input.summary ?? {}), timestamp, timestamp, jobId);
        const syncUpdate = await prepareSyncJobCompletion(row, input, "done", timestamp);
        if (syncUpdate) await database.batch([workerUpdate, syncUpdate]);
        else await workerUpdate.run();
        return { settlement: "ack" };
      }
      const errorClass = input.errorClass ?? "permanent";
      const errorMessage = (input.errorMessage ?? "worker job failed").slice(0, 500);
      if (decideJobSettlement({ attempts: row.attempts, errorClass }) === "retry") {
        await database
          .prepare(
            `UPDATE worker_jobs SET status = 'failed', error_class = ?, error_message = ?,
             updated_at = ? WHERE job_id = ?`,
          )
          .bind(errorClass, errorMessage, timestamp, jobId)
          .run();
        return {
          delaySeconds: Math.min(300, 30 * 2 ** Math.max(0, row.attempts - 1)),
          settlement: "retry",
        };
      }
      const payloadDigest = input.payloadDigest;
      if (!payloadDigest) throw new Error("payload digest is required for dead letter");
      const updates = [
        database
          .prepare(
            `UPDATE worker_jobs SET status = 'dead', error_class = ?, error_message = ?,
             updated_at = ?, finished_at = ? WHERE job_id = ?`,
          )
          .bind(errorClass, errorMessage, timestamp, timestamp, jobId),
        database
          .prepare(
            `INSERT INTO worker_dead_letters
             (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
              payload_digest, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(job_id) DO NOTHING`,
          )
          .bind(
            jobId,
            row.dedupe_key,
            row.kind,
            row.item_kind,
            row.attempts,
            errorClass,
            errorMessage,
            payloadDigest,
            timestamp,
          ),
      ];
      const syncUpdate = await prepareSyncJobCompletion(
        row,
        { ...input, errorMessage },
        "failed",
        timestamp,
      );
      if (syncUpdate) updates.push(syncUpdate);
      await database.batch(updates);
      return { settlement: "ack" };
    },

    async getChannels() {
      const channels = await getState("channels:safe");
      return {
        destinations: isRecord(channels) && isRecord(channels.destinations)
          ? channels.destinations
          : {},
        sources: isRecord(channels) && isRecord(channels.sources) ? channels.sources : {},
        status: "ok",
      };
    },

    async getCredential(name) {
      const row = await database
        .prepare("SELECT payload_encrypted FROM credentials WHERE name = ?")
        .bind(name)
        .first<{ payload_encrypted: ArrayBuffer }>();
      return row ? decryptJson(row.payload_encrypted, encryptionKey) : null;
    },

    async getLoginStatus(platform) {
      const row = await database
        .prepare(
          `SELECT status, expires_at, last_used_at, last_error
           FROM login_sessions WHERE platform = ?`,
        )
        .bind(platform)
        .first<{
          expires_at: string | null;
          last_error: string | null;
          last_used_at: string | null;
          status: string;
        }>();
      return row
        ? {
            expires_at: row.expires_at,
            last_error: row.last_error,
            last_used_at: row.last_used_at,
            platform,
            session_status: row.status,
            status: "ok",
          }
        : {
            note: "尚未建立登录会话（需先同步触发 worker 登录）",
            platform,
            session_status: "none",
            status: "ok",
          };
    },

    async getQueueDlq() {
      const result = await database
        .prepare(
          `SELECT job_id, dedupe_key, kind, item_kind, attempts, error_class,
                  error_message, payload_digest, created_at
           FROM worker_dead_letters ORDER BY created_at DESC LIMIT 100`,
        )
        .all<Record<string, unknown>>();
      const dlq = Object.fromEntries(
        ITEM_KINDS.map((kind) => [kind, [] as unknown[]]),
      ) as Record<ItemKind, unknown[]>;
      for (const row of result.results) {
        const kind = ITEM_KINDS.find((value) => value === row.item_kind);
        if (kind) dlq[kind].push(row);
      }
      return {
        counts: Object.fromEntries(ITEM_KINDS.map((kind) => [kind, dlq[kind].length])),
        dlq,
        status: "ok",
      };
    },

    async getQueueSummary() {
      const jobs = await database
        .prepare(
          `SELECT item_kind, status, COUNT(*) AS count FROM worker_jobs
           WHERE item_kind IS NOT NULL GROUP BY item_kind, status`,
        )
        .all<{ count: number; item_kind: ItemKind; status: string }>();
      const dead = await database
        .prepare(
          `SELECT item_kind, COUNT(*) AS count FROM worker_dead_letters
           WHERE item_kind IS NOT NULL GROUP BY item_kind`,
        )
        .all<{ count: number; item_kind: ItemKind }>();
      const queues = emptyQueueSummary();
      for (const row of jobs.results) {
        if (!ITEM_KINDS.includes(row.item_kind)) continue;
        if (row.status === "done") queues[row.item_kind].done = Number(row.count);
        if (row.status === "processing" || row.status === "failed") {
          queues[row.item_kind].pending += Number(row.count);
        }
      }
      for (const row of dead.results) {
        if (ITEM_KINDS.includes(row.item_kind)) {
          queues[row.item_kind].dlq = Number(row.count);
        }
      }
      return { queues, status: "ok" };
    },

    getState,

    async publishJobs(inputs) {
      const jobs = inputs.map((input) => parseQueueJob(input));
      await producer.sendBatch(jobs);
      return { queued: jobs.length };
    },

    async putLoginSession(platform, input) {
      const encrypted = await encryptJson(input.state, encryptionKey);
      const timestamp = nowIso();
      await database
        .prepare(
          `INSERT INTO login_sessions
           (platform, storage_state_encrypted, status, expires_at, last_used_at,
            last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform) DO UPDATE SET
             storage_state_encrypted = excluded.storage_state_encrypted,
             status = excluded.status, expires_at = excluded.expires_at,
             last_used_at = excluded.last_used_at, last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
        )
        .bind(
          platform,
          encrypted.buffer,
          input.status,
          input.expiresAt,
          timestamp,
          input.lastError ?? null,
          timestamp,
          timestamp,
        )
        .run();
    },

    putState,

    async recordArticleEvent(event) {
      await database
        .prepare(
          `INSERT INTO article_archive_events
           (source_url, url_fingerprint, title, status, reason, filename, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          event.sourceUrl,
          event.urlFingerprint,
          event.title,
          event.status,
          event.reason,
          event.filename,
          nowIso(),
        )
        .run();
    },

    async recordHeartbeat(workerId, details) {
      await database
        .prepare(
          `INSERT INTO worker_heartbeats (worker_id, last_seen_at, details) VALUES (?, ?, ?)
           ON CONFLICT(worker_id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at, details = excluded.details`,
        )
        .bind(workerId, nowIso(), JSON.stringify(details))
        .run();
    },

    async rejectInvalidJob(input) {
      const timestamp = nowIso();
      await database
        .prepare(
          `INSERT INTO worker_dead_letters
           (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
            payload_digest, created_at)
           VALUES (?, ?, 'invalid', NULL, ?, 'permanent', ?, ?, ?)
           ON CONFLICT(job_id) DO NOTHING`,
        )
        .bind(
          input.messageId,
          `invalid:${input.messageId}`,
          input.attempts,
          input.reason.slice(0, 500),
          input.payloadDigest,
          timestamp,
        )
        .run();
    },

    async writeCookie(platform, payload) {
      const fields: Readonly<Record<string, string>> = {
        bilibili: "sessdata",
        zhihu: "z_c0",
      };
      const field = fields[platform];
      if (!field) throw new UnsupportedCookiePlatformError(platform);
      if (typeof payload[field] !== "string" || payload[field].length === 0) {
        throw new MissingCookieFieldError(field);
      }
      const encrypted = await encryptJson({ [field]: payload[field] }, encryptionKey);
      const timestamp = nowIso();
      const name = `${platform}_creds`;
      await database
        .prepare(
          `INSERT INTO credentials
           (name, platform, kind, payload_encrypted, created_at, updated_at)
           VALUES (?, ?, 'cookie', ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET payload_encrypted = excluded.payload_encrypted,
             platform = excluded.platform, kind = excluded.kind,
             updated_at = excluded.updated_at`,
        )
        .bind(name, platform, encrypted.buffer, timestamp, timestamp)
        .run();
      return {
        note: "凭据已存，登录态将在下次同步时由 worker 建立",
        platform,
        status: "ok",
        vault_id: name,
      };
    },
  };
}

export class UnsupportedCookiePlatformError extends Error {}
export class MissingCookieFieldError extends Error {}

function isStale(updatedAt: string, current: Date): boolean {
  return current.getTime() - Date.parse(updatedAt) > 10 * 60 * 1_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyQueueSummary(): Record<
  ItemKind,
  { dlq: number; done: number; pending: number }
> {
  return Object.fromEntries(
    ITEM_KINDS.map((kind) => [kind, { dlq: 0, done: 0, pending: 0 }]),
  ) as Record<ItemKind, { dlq: number; done: number; pending: number }>;
}
