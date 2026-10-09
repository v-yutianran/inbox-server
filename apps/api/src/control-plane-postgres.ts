import { parseQueueJob, type QueueJob } from "@inbox/domain";

import { encryptJson } from "./credential-crypto.js";
import {
  calculateRetryDelaySeconds,
  decideJobTransition,
} from "./job-retry-policy.js";
import { advanceSyncJob } from "./operations.js";
import type { ControlPlaneService, JobResultInput } from "./control-plane.js";
import type { PostgresPool } from "./queue-inbox-postgres.js";

type PostgresControlPlaneCommands = Pick<
  ControlPlaneService,
  "claimJob" | "finishJob"
>;

interface WorkerJobRow extends Record<string, unknown> {
  readonly attempts: number | string;
  readonly created_at: string;
  readonly dedupe_key: string;
  readonly deferred_reason: string | null;
  readonly deferred_until: string | null;
  readonly failure_attempts: number | string;
  readonly item_kind: string | null;
  readonly job_id: string;
  readonly kind: string;
  readonly status: "processing" | "deferred" | "done" | "failed" | "dead" | "uncertain";
  readonly updated_at: string;
}

interface WorkerEnvelopeRow extends Record<string, unknown> {
  readonly payload_digest: string;
}

export function createPostgresControlPlaneCommandService(options: {
  readonly encryptionKey: string;
  readonly now?: () => Date;
  readonly pool: PostgresPool;
}): PostgresControlPlaneCommands {
  const now = options.now ?? (() => new Date());
  const nowIso = () => now().toISOString();

  return {
    async claimJob(input) {
      const job = parseQueueJob(input);
      const timestamp = nowIso();
      return withTransaction(options.pool, async (client) => {
        const inserted = await client.query<{ attempts: number | string } & Record<string, unknown>>(
          `INSERT INTO inbox_server.worker_jobs
           (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'processing', 1, $5, $6)
           ON CONFLICT DO NOTHING
           RETURNING attempts`,
          [
            job.dedupeKey,
            job.jobId,
            job.kind,
            job.kind === "dispatch-item" ? job.payload.itemKind : null,
            job.createdAt,
            timestamp,
          ],
        );
        if (inserted.rows[0]) {
          if (job.kind === "dispatch-item" && job.payload.itemKind === "article") {
            const ciphertext = await encryptJson(job, options.encryptionKey);
            const digest = await digestJob(job);
            await client.query(
              `INSERT INTO inbox_server.worker_job_envelopes
               (job_id, dedupe_key, schema_version, payload_digest, ciphertext, status,
                created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
               ON CONFLICT (job_id) DO NOTHING`,
              [job.jobId, job.dedupeKey, job.schemaVersion, digest, ciphertext, timestamp],
            );
          }
          return { attempts: safeInteger(inserted.rows[0].attempts), state: "claimed" };
        }

        const existingResult = await client.query<WorkerJobRow>(
          `SELECT attempts, created_at, dedupe_key, deferred_reason, deferred_until,
                  failure_attempts, item_kind, job_id, kind, status, updated_at
           FROM inbox_server.worker_jobs WHERE dedupe_key = $1 FOR UPDATE`,
          [job.dedupeKey],
        );
        const existing = existingResult.rows[0];
        if (!existing) throw new Error("job claim not found after dedupe conflict");
        if (
          existing.status === "done" ||
          existing.status === "dead" ||
          existing.status === "uncertain"
        ) {
          return { state: "duplicate" };
        }
        if (
          existing.status === "deferred" &&
          existing.deferred_until &&
          Date.parse(existing.deferred_until) > now().getTime()
        ) {
          return {
            reason: existing.deferred_reason ?? "deferred",
            retryAt: existing.deferred_until,
            state: "deferred",
          };
        }
        if (existing.status === "processing" && !isStale(existing.updated_at, now())) {
          return { state: "busy" };
        }

        const updated = await client.query<{ attempts: number | string } & Record<string, unknown>>(
          `UPDATE inbox_server.worker_jobs
           SET attempts = attempts + 1, job_id = $1, status = 'processing', updated_at = $2,
               deferred_until = NULL, deferred_reason = NULL, error_class = NULL,
               error_message = NULL, finished_at = NULL
           WHERE dedupe_key = $3 RETURNING attempts`,
          [job.jobId, timestamp, job.dedupeKey],
        );
        const claimed = updated.rows[0];
        if (!claimed) throw new Error("job claim disappeared while locked");
        return { attempts: safeInteger(claimed.attempts), state: "claimed" };
      });
    },

    async finishJob(jobId, input) {
      const timestamp = nowIso();
      return withTransaction(options.pool, async (client) => {
        const selected = await client.query<WorkerJobRow>(
          `SELECT attempts, created_at, dedupe_key, deferred_reason, deferred_until,
                  failure_attempts, item_kind, job_id, kind, status, updated_at
           FROM inbox_server.worker_jobs WHERE job_id = $1 FOR UPDATE`,
          [jobId],
        );
        const row = selected.rows[0];
        if (!row) throw new Error("job claim not found");
        if (row.status === "done" || row.status === "dead" || row.status === "uncertain") {
          return { settlement: "ack" };
        }
        if (input.status === "deferred") {
          await client.query(
            `UPDATE inbox_server.worker_jobs
             SET status = 'deferred', deferral_count = deferral_count + 1,
                 deferred_until = $1, deferred_reason = $2, updated_at = $3,
                 error_class = NULL, error_message = NULL WHERE job_id = $4`,
            [input.retryAt, input.reason, timestamp, jobId],
          );
          return {
            delaySeconds: calculateRetryDelaySeconds(input.retryAt, now()),
            settlement: "retry",
          };
        }
        if (input.status === "uncertain") {
          await client.query(
            `UPDATE inbox_server.worker_jobs
             SET status = 'uncertain', error_message = $1, updated_at = $2, finished_at = $2
             WHERE job_id = $3`,
            [input.reason.slice(0, 500), timestamp, jobId],
          );
          await client.query(
            `UPDATE inbox_server.worker_job_envelopes
             SET status = 'uncertain', updated_at = $1 WHERE job_id = $2`,
            [timestamp, jobId],
          );
          return { settlement: "ack" };
        }
        if (input.status === "done") {
          await client.query(
            `UPDATE inbox_server.worker_jobs
             SET status = 'done', summary = $1, updated_at = $2, finished_at = $2,
                 deferred_until = NULL, deferred_reason = NULL,
                 error_class = NULL, error_message = NULL WHERE job_id = $3`,
            [JSON.stringify(input.summary ?? {}), timestamp, jobId],
          );
          await client.query(
            "DELETE FROM inbox_server.worker_job_envelopes WHERE job_id = $1",
            [jobId],
          );
          await updateSyncJobCompletion(client, row, input, "done", timestamp);
          return { settlement: "ack" };
        }

        const errorClass = input.errorClass ?? "permanent";
        const errorMessage = (input.errorMessage ?? "worker job failed").slice(0, 500);
        const transition = decideJobTransition(
          {
            failureAttempts: safeInteger(row.failure_attempts),
            status: row.status,
          },
          { errorClass, kind: "failed" },
        );
        if (transition.status === "failed") {
          await client.query(
            `UPDATE inbox_server.worker_jobs
             SET status = 'failed', failure_attempts = $1, error_class = $2,
                 error_message = $3, updated_at = $4, deferred_until = NULL,
                 deferred_reason = NULL WHERE job_id = $5`,
            [transition.failureAttempts, errorClass, errorMessage, timestamp, jobId],
          );
          return {
            delaySeconds: Math.min(
              300,
              30 * 2 ** Math.max(0, transition.failureAttempts - 1),
            ),
            settlement: "retry",
          };
        }

        const envelopeResult = await client.query<WorkerEnvelopeRow>(
          `SELECT payload_digest FROM inbox_server.worker_job_envelopes
           WHERE job_id = $1 FOR UPDATE`,
          [jobId],
        );
        const envelope = envelopeResult.rows[0];
        const payloadDigest = envelope?.payload_digest ?? input.payloadDigest;
        if (!payloadDigest) throw new Error("payload digest is required for dead letter");
        await client.query(
          `UPDATE inbox_server.worker_jobs
           SET status = 'dead', failure_attempts = $1, error_class = $2,
               error_message = $3, updated_at = $4, finished_at = $4,
               deferred_until = NULL, deferred_reason = NULL WHERE job_id = $5`,
          [transition.failureAttempts, errorClass, errorMessage, timestamp, jobId],
        );
        await client.query(
          `INSERT INTO inbox_server.worker_dead_letters
           (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
            payload_digest, envelope_job_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (job_id) DO UPDATE SET
             attempts = EXCLUDED.attempts,
             error_class = EXCLUDED.error_class,
             error_message = EXCLUDED.error_message,
             payload_digest = EXCLUDED.payload_digest,
             envelope_job_id = EXCLUDED.envelope_job_id,
             created_at = EXCLUDED.created_at`,
          [
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
          ],
        );
        await client.query(
          `UPDATE inbox_server.worker_job_envelopes
           SET status = 'dead', updated_at = $1 WHERE job_id = $2`,
          [timestamp, jobId],
        );
        await updateSyncJobCompletion(client, row, { ...input, errorMessage }, "failed", timestamp);
        return { settlement: "ack" };
      });
    },
  };
}

async function digestJob(job: QueueJob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(job)));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function withTransaction<T>(
  pool: PostgresPool,
  operation: (client: Awaited<ReturnType<PostgresPool["connect"]>>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      throw new AggregateError([error, rollbackError], "PostgreSQL transaction and rollback failed");
    }
    throw error;
  } finally {
    await client.release(releaseError);
  }
}

type PostgresClient = Awaited<ReturnType<PostgresPool["connect"]>>;

async function updateSyncJobCompletion(
  client: PostgresClient,
  row: WorkerJobRow,
  input: JobResultInput,
  status: "done" | "failed",
  timestamp: string,
): Promise<void> {
  if (row.kind !== "collect-source") return;
  const match = /^collect:([^:]+):(.+)$/.exec(row.dedupe_key);
  if (!match?.[1] || !match[2]) return;
  const result = await client.query<{ stats: string } & Record<string, unknown>>(
    "SELECT stats FROM inbox_server.sync_jobs WHERE id = $1 FOR UPDATE",
    [match[2]],
  );
  const syncJob = result.rows[0];
  if (!syncJob) return;
  const next = advanceSyncJob(JSON.parse(syncJob.stats) as Record<string, unknown>, {
    ...("errorMessage" in input && input.errorMessage
      ? { errorMessage: input.errorMessage.slice(0, 500) }
      : {}),
    finishedAt: timestamp,
    source: match[1],
    status,
    ...(input.status === "done" && input.summary ? { summary: input.summary } : {}),
  });
  await client.query(
    `UPDATE inbox_server.sync_jobs
     SET stats = $1, status = $2, error = $3, finished_at = $4 WHERE id = $5`,
    [JSON.stringify(next.stats), next.status, next.error, next.finishedAt, match[2]],
  );
}

function isStale(updatedAt: string, current: Date): boolean {
  return current.getTime() - Date.parse(updatedAt) > 10 * 60_000;
}

function safeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("PostgreSQL integer exceeds safe range");
  return parsed;
}
