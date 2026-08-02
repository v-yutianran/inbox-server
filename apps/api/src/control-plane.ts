import { parseQueueJob, type QueueJob } from "@inbox/domain";

import type { ApiBindings } from "./auth.js";
import type { JobErrorClass } from "./control-plane-contract.js";
import { decryptJson, encryptJson } from "./credential-crypto.js";
import {
  calculateRetryDelaySeconds,
  decideJobTransition,
  decideRateLimitBatch,
  type RateLimitInput,
  type RateLimitState,
} from "./job-retry-policy.js";
import { advanceSyncJob } from "./operations.js";
import { createQueueProducer, type QueueProducer } from "./queue-producer.js";

const ITEM_KINDS = ["link", "text", "file", "article"] as const;
type ItemKind = (typeof ITEM_KINDS)[number];

type JsonRecord = Readonly<Record<string, unknown>>;

export type JobResultInput =
  | { readonly status: "done"; readonly summary?: JsonRecord }
  | {
      readonly errorClass?: JobErrorClass;
      readonly errorMessage?: string;
      readonly payloadDigest?: string;
      readonly status: "failed";
    }
  | {
      readonly reason: "effect_busy" | "rate_limit";
      readonly retryAt: string;
      readonly status: "deferred";
    }
  | { readonly reason: string; readonly status: "uncertain" };

export interface ReplayResult {
  readonly published: boolean;
  readonly reason: string;
  readonly replayable: boolean;
  readonly status: "published" | "rejected" | "validated";
}

export interface ControlPlaneService {
  claimEffect(input: {
    readonly destination: string;
    readonly effectKey: string;
    readonly jobId: string;
  }): Promise<{
    readonly attempts?: number;
    readonly retryAt?: string;
    readonly state: "busy" | "claimed" | "done" | "uncertain";
  }>;
  claimJob(job: QueueJob): Promise<{
    readonly attempts?: number;
    readonly reason?: string;
    readonly retryAt?: string;
    readonly state: "busy" | "claimed" | "deferred" | "duplicate";
  }>;
  consumeRateLimit(input: {
    readonly bucketKey: string;
    readonly limit: number;
    readonly scope: string;
    readonly windowSeconds: number;
  }): Promise<{ readonly allowed: boolean; readonly count: number; readonly retryAt?: string }>;
  consumeRateLimits(inputs: readonly RateLimitInput[]): Promise<{
    readonly allowed: boolean;
    readonly counts: Readonly<Record<string, number>>;
    readonly retryAt?: string;
  }>;
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
  replayDeadLetter(
    jobId: string,
    input: { readonly dryRun: boolean; readonly idempotencyKey: string },
  ): Promise<ReplayResult>;
  writeCookie(platform: string, payload: JsonRecord): Promise<JsonRecord>;
}

interface ControlPlaneOptions {
  readonly database: D1Database;
  readonly encryptionKey: string;
  readonly log?: (event: string, context: JsonRecord) => void;
  readonly now?: () => Date;
  readonly producer: QueueProducer;
}

interface WorkerJobRow {
  readonly attempts: number;
  readonly created_at: string;
  readonly dedupe_key: string;
  readonly deferred_reason: string | null;
  readonly deferred_until: string | null;
  readonly failure_attempts: number;
  readonly item_kind: ItemKind | null;
  readonly job_id: string;
  readonly kind: string;
  readonly status: "processing" | "deferred" | "done" | "failed" | "dead" | "uncertain";
  readonly updated_at: string;
}

interface WorkerEffectRow {
  readonly attempts: number;
  readonly status: "processing" | "done" | "failed" | "uncertain";
  readonly updated_at: string;
}

interface WorkerEnvelopeRow {
  readonly ciphertext: ArrayBuffer | Uint8Array;
  readonly payload_digest: string;
  readonly schema_version: number;
  readonly status: "active" | "dead" | "uncertain";
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
  log = (event, context) => console.log(JSON.stringify({ event, ...context })),
  now = () => new Date(),
  producer,
}: ControlPlaneOptions): ControlPlaneService {
  const nowIso = () => now().toISOString();

  async function sha256Hex(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  async function digestJob(job: QueueJob): Promise<string> {
    return sha256Hex(JSON.stringify(job));
  }

  async function prepareArticleEnvelope(
    job: QueueJob,
    timestamp: string,
  ): Promise<D1PreparedStatement | null> {
    if (job.kind !== "dispatch-item" || job.payload.itemKind !== "article") return null;
    const ciphertext = await encryptJson(job, encryptionKey);
    return database
      .prepare(
        `INSERT INTO worker_job_envelopes
         (job_id, dedupe_key, schema_version, payload_digest, ciphertext, status,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(
        job.jobId,
        job.dedupeKey,
        job.schemaVersion,
        await digestJob(job),
        ciphertext.buffer,
        timestamp,
        timestamp,
      );
  }

  function rejectedReplay(jobId: string, reason: string): ReplayResult {
    log("worker.job.replay_rejected", {
      description: "死信重放校验被拒绝",
      jobId,
      reason,
    });
    return { published: false, reason, replayable: false, status: "rejected" };
  }

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
      ...("errorMessage" in input && input.errorMessage
        ? { errorMessage: input.errorMessage.slice(0, 500) }
        : {}),
      finishedAt: timestamp,
      source,
      status: terminalStatus,
      ...(input.status === "done" && input.summary ? { summary: input.summary } : {}),
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
        return {
          retryAt: new Date(Date.parse(existing.updated_at) + 10 * 60_000).toISOString(),
          state: "busy",
        };
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
          `SELECT attempts, created_at, dedupe_key, deferred_reason, deferred_until,
                  failure_attempts, item_kind, job_id, kind, status, updated_at
           FROM worker_jobs WHERE dedupe_key = ?`,
        )
        .bind(job.dedupeKey)
        .first<WorkerJobRow>();
      if (
        existing?.status === "done" ||
        existing?.status === "dead" ||
        existing?.status === "uncertain"
      ) {
        return { state: "duplicate" };
      }
      if (
        existing?.status === "deferred" &&
        existing.deferred_until &&
        Date.parse(existing.deferred_until) > now().getTime()
      ) {
        return {
          reason: existing.deferred_reason ?? "deferred",
          retryAt: existing.deferred_until,
          state: "deferred",
        };
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
                 deferred_until = NULL, deferred_reason = NULL, error_class = NULL,
                 error_message = NULL, finished_at = NULL
             WHERE dedupe_key = ?`,
          )
          .bind(attempts, job.jobId, timestamp, job.dedupeKey)
          .run();
        return { attempts, state: "claimed" };
      }
      const itemKind = job.kind === "dispatch-item" ? job.payload.itemKind : null;
      const workerInsert = database
        .prepare(
          `INSERT INTO worker_jobs
           (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'processing', 1, ?, ?)`,
        )
        .bind(job.dedupeKey, job.jobId, job.kind, itemKind, job.createdAt, timestamp);
      const envelopeInsert = await prepareArticleEnvelope(job, timestamp);
      if (envelopeInsert) await database.batch([workerInsert, envelopeInsert]);
      else await workerInsert.run();
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

    async consumeRateLimits(inputs) {
      if (inputs.length === 0) return { allowed: true, counts: {} };
      const batchScope = [...new Set(inputs.map((input) => input.scope))]
        .sort()
        .join("|");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await database
          .prepare(
            "SELECT state, version FROM worker_rate_limit_batches WHERE scope = ?",
          )
          .bind(batchScope)
          .first<{ state: string; version: number }>();
        const states = row ? (JSON.parse(row.state) as RateLimitState[]) : [];
        const decision = decideRateLimitBatch(inputs, states, now());
        if (!decision.allowed) {
          return {
            allowed: false,
            counts: decision.counts,
            retryAt: decision.retryAt,
          };
        }
        const timestamp = nowIso();
        const result = row
          ? await database
              .prepare(
                `UPDATE worker_rate_limit_batches
                 SET state = ?, version = ?, updated_at = ?
                 WHERE scope = ? AND version = ?`,
              )
              .bind(
                JSON.stringify(decision.nextStates),
                row.version + 1,
                timestamp,
                batchScope,
                row.version,
              )
              .run()
          : await database
              .prepare(
                `INSERT OR IGNORE INTO worker_rate_limit_batches
                 (scope, state, version, updated_at) VALUES (?, ?, 1, ?)`,
              )
              .bind(batchScope, JSON.stringify(decision.nextStates), timestamp)
              .run();
        if (Number(result.meta?.changes ?? 0) > 0) {
          return { allowed: true, counts: decision.counts };
        }
      }
      throw new Error("rate limit batch contention");
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
          `SELECT attempts, created_at, dedupe_key, deferred_reason, deferred_until,
                  failure_attempts, item_kind, job_id, kind, status, updated_at
           FROM worker_jobs WHERE job_id = ?`,
        )
        .bind(jobId)
        .first<WorkerJobRow>();
      if (!row) throw new Error("job claim not found");
      if (row.status === "done" || row.status === "dead" || row.status === "uncertain") {
        return { settlement: "ack" };
      }
      const timestamp = nowIso();
      if (input.status === "deferred") {
        await database
          .prepare(
            `UPDATE worker_jobs
             SET status = 'deferred', deferral_count = deferral_count + 1,
                 deferred_until = ?, deferred_reason = ?, updated_at = ?,
                 error_class = NULL, error_message = NULL
             WHERE job_id = ?`,
          )
          .bind(input.retryAt, input.reason, timestamp, jobId)
          .run();
        return {
          delaySeconds: calculateRetryDelaySeconds(input.retryAt, now()),
          settlement: "retry",
        };
      }
      if (input.status === "uncertain") {
        const updates = [
          database
            .prepare(
              `UPDATE worker_jobs
               SET status = 'uncertain', error_message = ?, updated_at = ?, finished_at = ?
               WHERE job_id = ?`,
            )
            .bind(input.reason.slice(0, 500), timestamp, timestamp, jobId),
          database
            .prepare(
              `UPDATE worker_job_envelopes SET status = 'uncertain', updated_at = ?
               WHERE job_id = ?`,
            )
            .bind(timestamp, jobId),
        ];
        await database.batch(updates);
        return { settlement: "ack" };
      }
      if (input.status === "done") {
        const updates = [
          database
            .prepare(
              `UPDATE worker_jobs SET status = 'done', summary = ?, updated_at = ?,
               finished_at = ?, deferred_until = NULL, deferred_reason = NULL,
               error_class = NULL, error_message = NULL WHERE job_id = ?`,
            )
            .bind(JSON.stringify(input.summary ?? {}), timestamp, timestamp, jobId),
          database
            .prepare("DELETE FROM worker_job_envelopes WHERE job_id = ?")
            .bind(jobId),
        ];
        const syncUpdate = await prepareSyncJobCompletion(row, input, "done", timestamp);
        if (syncUpdate) updates.push(syncUpdate);
        await database.batch(updates);
        return { settlement: "ack" };
      }
      const errorClass = input.errorClass ?? "permanent";
      const errorMessage = (input.errorMessage ?? "worker job failed").slice(0, 500);
      const transition = decideJobTransition(
        { failureAttempts: row.failure_attempts, status: row.status },
        { errorClass, kind: "failed" },
      );
      if (transition.status === "failed") {
        await database
          .prepare(
            `UPDATE worker_jobs
             SET status = 'failed', failure_attempts = ?, error_class = ?, error_message = ?,
                 updated_at = ?, deferred_until = NULL, deferred_reason = NULL
             WHERE job_id = ?`,
          )
          .bind(transition.failureAttempts, errorClass, errorMessage, timestamp, jobId)
          .run();
        return {
          delaySeconds: Math.min(
            300,
            30 * 2 ** Math.max(0, transition.failureAttempts - 1),
          ),
          settlement: "retry",
        };
      }
      const envelope = await database
        .prepare(
          "SELECT payload_digest FROM worker_job_envelopes WHERE job_id = ?",
        )
        .bind(jobId)
        .first<{ payload_digest: string }>();
      const payloadDigest = envelope?.payload_digest ?? input.payloadDigest;
      if (!payloadDigest) throw new Error("payload digest is required for dead letter");
      const updates = [
        database
          .prepare(
            `UPDATE worker_jobs
             SET status = 'dead', failure_attempts = ?, error_class = ?, error_message = ?,
                 updated_at = ?, finished_at = ?, deferred_until = NULL,
                 deferred_reason = NULL WHERE job_id = ?`,
          )
          .bind(
            transition.failureAttempts,
            errorClass,
            errorMessage,
            timestamp,
            timestamp,
            jobId,
          ),
        database
          .prepare(
            `INSERT INTO worker_dead_letters
             (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
              payload_digest, envelope_job_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET
               attempts = excluded.attempts,
               error_class = excluded.error_class,
               error_message = excluded.error_message,
               payload_digest = excluded.payload_digest,
               envelope_job_id = excluded.envelope_job_id,
               created_at = excluded.created_at`,
          )
          .bind(
            jobId,
            row.dedupe_key,
            row.kind,
            row.item_kind,
            transition.failureAttempts,
            errorClass,
            errorMessage,
            payloadDigest,
            envelope ? jobId : null,
            timestamp,
          ),
        database
          .prepare(
            `UPDATE worker_job_envelopes SET status = 'dead', updated_at = ?
             WHERE job_id = ?`,
          )
          .bind(timestamp, jobId),
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
        if (
          row.status === "processing" ||
          row.status === "deferred" ||
          row.status === "failed"
        ) {
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

    async replayDeadLetter(jobId, input) {
      const jobState = await database
        .prepare("SELECT status FROM worker_jobs WHERE job_id = ?")
        .bind(jobId)
        .first<{ status: string }>();
      if (jobState?.status === "done" || jobState?.status === "uncertain") {
        return rejectedReplay(jobId, `${jobState.status}_terminal`);
      }
      const effect = await database
        .prepare(
          `SELECT status FROM worker_effects
           WHERE job_id = ? AND status IN ('done', 'uncertain') LIMIT 1`,
        )
        .bind(jobId)
        .first<{ status: "done" | "uncertain" }>();
      if (effect) return rejectedReplay(jobId, `${effect.status}_terminal`);

      const existingOperation = await database
        .prepare(
          `SELECT job_id, reason, status FROM worker_replay_operations
           WHERE idempotency_key = ?`,
        )
        .bind(input.idempotencyKey)
        .first<{
          job_id: string;
          reason: string;
          status: "published" | "rejected";
        }>();
      if (existingOperation) {
        if (existingOperation.job_id !== jobId) {
          return rejectedReplay(jobId, "idempotency_conflict");
        }
        log("worker.job.replay_published", {
          description: "死信重放已由相同运维幂等键发布",
          jobId,
          reason: existingOperation.reason,
        });
        return {
          published: existingOperation.status === "published",
          reason: existingOperation.reason,
          replayable: existingOperation.status === "published",
          status: existingOperation.status,
        };
      }

      const deadLetter = await database
        .prepare(
          `SELECT envelope_job_id FROM worker_dead_letters WHERE job_id = ?`,
        )
        .bind(jobId)
        .first<{ envelope_job_id: string | null }>();
      if (!deadLetter?.envelope_job_id) {
        return rejectedReplay(jobId, "historical_unrecoverable");
      }
      const envelope = await database
        .prepare(
          `SELECT ciphertext, payload_digest, schema_version, status
           FROM worker_job_envelopes WHERE job_id = ?`,
        )
        .bind(deadLetter.envelope_job_id)
        .first<WorkerEnvelopeRow>();
      if (!envelope || envelope.status !== "dead") {
        return rejectedReplay(jobId, "envelope_unavailable");
      }

      let job: QueueJob;
      try {
        job = parseQueueJob(await decryptJson(envelope.ciphertext, encryptionKey));
      } catch {
        return rejectedReplay(jobId, "envelope_invalid");
      }
      if (
        job.jobId !== jobId ||
        job.schemaVersion !== envelope.schema_version ||
        (await digestJob(job)) !== envelope.payload_digest
      ) {
        return rejectedReplay(jobId, "envelope_mismatch");
      }
      if (input.dryRun) {
        log("worker.job.replay_validated", {
          description: "死信重放校验通过",
          jobId,
          reason: "replayable",
        });
        return {
          published: false,
          reason: "replayable",
          replayable: true,
          status: "validated",
        };
      }

      const timestamp = nowIso();
      const messageId = `replay-${await sha256Hex(`${jobId}\u0000${input.idempotencyKey}`)}`;
      try {
        await database.batch([
          database
            .prepare(
              `INSERT INTO worker_replay_operations
               (idempotency_key, job_id, message_id, status, reason, created_at, updated_at)
               VALUES (?, ?, ?, 'published', 'published', ?, ?)`,
            )
            .bind(input.idempotencyKey, jobId, messageId, timestamp, timestamp),
          database
            .prepare(
              `INSERT OR IGNORE INTO worker_inbox
               (message_id, body, status, attempts, available_at, timestamp_ms,
                created_at, updated_at)
               VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`,
            )
            .bind(
              messageId,
              JSON.stringify(job),
              timestamp,
              now().getTime(),
              timestamp,
              timestamp,
            ),
          database
            .prepare(
              `UPDATE worker_jobs
               SET status = 'failed', failure_attempts = 0, error_class = NULL,
                   error_message = NULL, finished_at = NULL, updated_at = ?
               WHERE job_id = ? AND status = 'dead'`,
            )
            .bind(timestamp, jobId),
          database
            .prepare(
              `UPDATE worker_job_envelopes SET status = 'active', updated_at = ?
               WHERE job_id = ? AND status = 'dead'`,
            )
            .bind(timestamp, jobId),
        ]);
      } catch (error: unknown) {
        const concurrent = await database
          .prepare(
            `SELECT job_id, status FROM worker_replay_operations
             WHERE idempotency_key = ?`,
          )
          .bind(input.idempotencyKey)
          .first<{ job_id: string; status: string }>();
        if (concurrent?.job_id !== jobId || concurrent.status !== "published") throw error;
      }
      log("worker.job.replay_published", {
        description: "死信任务已幂等暂存等待重新处理",
        jobId,
        reason: "published",
      });
      return {
        published: true,
        reason: "published",
        replayable: true,
        status: "published",
      };
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
