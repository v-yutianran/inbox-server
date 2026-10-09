import { parseQueueJob, type QueueJob } from "@inbox/domain";

import type { ControlPlaneService, ReplayResult } from "./control-plane.js";
import { decryptJson } from "./credential-crypto.js";
import type { PostgresPool } from "./queue-inbox-postgres.js";

type ReplayService = Pick<ControlPlaneService, "replayDeadLetter">;
type PostgresClient = Awaited<ReturnType<PostgresPool["connect"]>>;

interface ReplayEnvelope extends Record<string, unknown> {
  readonly ciphertext: Uint8Array;
  readonly payload_digest: string;
  readonly schema_version: number | string;
  readonly status: "active" | "dead" | "uncertain";
}

interface ReplayOperation extends Record<string, unknown> {
  readonly job_id: string;
  readonly reason: string;
  readonly status: "published" | "rejected";
}

export function createPostgresControlPlaneReplayService(options: {
  readonly encryptionKey: string;
  readonly log?: (event: string, context: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => Date;
  readonly pool: PostgresPool;
}): ReplayService {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((event, context) => console.log(JSON.stringify({ event, ...context })));

  function rejected(jobId: string, reason: string): ReplayResult {
    log("worker.job.replay_rejected", {
      description: "死信重放校验被拒绝",
      jobId,
      reason,
    });
    return { published: false, reason, replayable: false, status: "rejected" };
  }

  return {
    async replayDeadLetter(jobId, input) {
      let successLog: { readonly description: string; readonly event: string; readonly reason: string } | undefined;
      const result: ReplayResult = await withTransaction<ReplayResult>(options.pool, async (client) => {
        if (!input.dryRun) {
          // 重放按运维键串行化；散列碰撞只会让无关键额外等待。
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.idempotencyKey]);
        }

        const jobResult = await client.query<{ status: string } & Record<string, unknown>>(
          `SELECT status FROM inbox_server.worker_jobs WHERE job_id = $1${input.dryRun ? "" : " FOR UPDATE"}`,
          [jobId],
        );
        const jobState = jobResult.rows[0];
        if (jobState?.status === "done" || jobState?.status === "uncertain") {
          return rejected(jobId, `${jobState.status}_terminal`);
        }

        const terminalEffect = await client.query<{ status: "done" | "uncertain" } & Record<string, unknown>>(
          `SELECT status FROM inbox_server.worker_effects
           WHERE job_id = $1 AND status IN ('done', 'uncertain') LIMIT 1${input.dryRun ? "" : " FOR UPDATE"}`,
          [jobId],
        );
        const effect = terminalEffect.rows[0];
        if (effect) return rejected(jobId, `${effect.status}_terminal`);

        const operationResult = await client.query<ReplayOperation>(
          `SELECT job_id, reason, status FROM inbox_server.worker_replay_operations
           WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        );
        const existingOperation = operationResult.rows[0];
        if (existingOperation) {
          if (existingOperation.job_id !== jobId) return rejected(jobId, "idempotency_conflict");
          successLog = {
            description: "死信重放已由相同运维幂等键发布",
            event: "worker.job.replay_published",
            reason: existingOperation.reason,
          };
          return {
            published: existingOperation.status === "published",
            reason: existingOperation.reason,
            replayable: existingOperation.status === "published",
            status: existingOperation.status,
          };
        }

        const deadLetterResult = await client.query<{ envelope_job_id: string | null } & Record<string, unknown>>(
          "SELECT envelope_job_id FROM inbox_server.worker_dead_letters WHERE job_id = $1",
          [jobId],
        );
        const envelopeJobId = deadLetterResult.rows[0]?.envelope_job_id;
        if (!envelopeJobId) return rejected(jobId, "historical_unrecoverable");

        const envelopeResult = await client.query<ReplayEnvelope>(
          `SELECT ciphertext, payload_digest, schema_version, status
           FROM inbox_server.worker_job_envelopes WHERE job_id = $1`,
          [envelopeJobId],
        );
        const envelope = envelopeResult.rows[0];
        if (!envelope || envelope.status !== "dead") return rejected(jobId, "envelope_unavailable");

        let job: QueueJob;
        try {
          job = parseQueueJob(await decryptJson(envelope.ciphertext, options.encryptionKey));
        } catch {
          return rejected(jobId, "envelope_invalid");
        }
        if (
          job.jobId !== jobId ||
          job.schemaVersion !== Number(envelope.schema_version) ||
          (await digestJob(job)) !== envelope.payload_digest
        ) {
          return rejected(jobId, "envelope_mismatch");
        }

        if (input.dryRun) {
          successLog = {
            description: "死信重放校验通过",
            event: "worker.job.replay_validated",
            reason: "replayable",
          };
          return { published: false, reason: "replayable", replayable: true, status: "validated" };
        }

        const timestamp = now().toISOString();
        const messageId = `replay-${await sha256Hex(`${jobId}\u0000${input.idempotencyKey}`)}`;
        const inserted = await client.query<ReplayOperation>(
          `INSERT INTO inbox_server.worker_replay_operations
           (idempotency_key, job_id, message_id, status, reason, created_at, updated_at)
           VALUES ($1, $2, $3, 'published', 'published', $4, $4)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING job_id, reason, status`,
          [input.idempotencyKey, jobId, messageId, timestamp],
        );
        const operation = inserted.rows[0];
        if (!operation) {
          const concurrentResult = await client.query<ReplayOperation>(
            `SELECT job_id, reason, status FROM inbox_server.worker_replay_operations
             WHERE idempotency_key = $1`,
            [input.idempotencyKey],
          );
          const concurrent = concurrentResult.rows[0];
          if (!concurrent || concurrent.job_id !== jobId) return rejected(jobId, "idempotency_conflict");
          successLog = {
            description: "死信重放已由相同运维幂等键发布",
            event: "worker.job.replay_published",
            reason: concurrent.reason,
          };
          return {
            published: concurrent.status === "published",
            reason: concurrent.reason,
            replayable: concurrent.status === "published",
            status: concurrent.status,
          };
        }

        await client.query(
          `INSERT INTO inbox_server.worker_inbox
           (message_id, body, status, attempts, available_at, timestamp_ms, created_at, updated_at)
           VALUES ($1, $2, 'queued', 0, $3, $4, $3, $3)
           ON CONFLICT (message_id) DO NOTHING`,
          [messageId, JSON.stringify(job), timestamp, now().getTime()],
        );
        await client.query(
          `UPDATE inbox_server.worker_jobs
           SET status = 'failed', failure_attempts = 0, error_class = NULL,
               error_message = NULL, finished_at = NULL, updated_at = $1
           WHERE job_id = $2 AND status = 'dead'`,
          [timestamp, jobId],
        );
        await client.query(
          `UPDATE inbox_server.worker_job_envelopes
           SET status = 'active', updated_at = $1 WHERE job_id = $2 AND status = 'dead'`,
          [timestamp, envelopeJobId],
        );
        successLog = {
          description: "死信任务已幂等暂存等待重新处理",
          event: "worker.job.replay_published",
          reason: "published",
        };
        return { published: true, reason: "published", replayable: true, status: "published" };
      });
      if (successLog) log(successLog.event, { ...successLog, jobId });
      return result;
    },
  };
}

async function digestJob(job: QueueJob): Promise<string> {
  return sha256Hex(JSON.stringify(job));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function withTransaction<T>(
  pool: PostgresPool,
  operation: (client: PostgresClient) => Promise<T>,
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
