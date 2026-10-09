import type { ControlPlaneService } from "./control-plane.js";
import {
  decideRateLimitBatch,
  type RateLimitInput,
  type RateLimitState,
} from "./job-retry-policy.js";
import type { PostgresPool } from "./queue-inbox-postgres.js";

type EffectsService = Pick<
  ControlPlaneService,
  "claimEffect" | "consumeRateLimit" | "consumeRateLimits" | "finishEffect"
>;
type PostgresClient = Awaited<ReturnType<PostgresPool["connect"]>>;

interface EffectRow extends Record<string, unknown> {
  readonly attempts: number | string;
  readonly status: "processing" | "done" | "failed" | "uncertain";
  readonly updated_at: string;
}

interface RateLimitRow extends Record<string, unknown> {
  readonly count: number | string;
  readonly expires_at: string;
}

interface RateLimitBatchRow extends Record<string, unknown> {
  readonly state: string;
  readonly version: number | string;
}

export function createPostgresControlPlaneEffectsService(options: {
  readonly pool: PostgresPool;
  readonly now?: () => Date;
}): EffectsService {
  const now = options.now ?? (() => new Date());

  return {
    async claimEffect(input) {
      return withTransaction(options.pool, async (client) => {
        const timestamp = now().toISOString();
        const inserted = await client.query<Pick<EffectRow, "attempts"> & Record<string, unknown>>(
          `INSERT INTO inbox_server.worker_effects
           (effect_key, job_id, destination, status, attempts, updated_at)
           VALUES ($1, $2, $3, 'processing', 1, $4)
           ON CONFLICT (effect_key) DO NOTHING
           RETURNING attempts`,
          [input.effectKey, input.jobId, input.destination, timestamp],
        );
        if (inserted.rows[0] !== undefined) {
          return { attempts: Number(inserted.rows[0].attempts), state: "claimed" };
        }

        const result = await client.query<EffectRow>(
          `SELECT attempts, status, updated_at FROM inbox_server.worker_effects
           WHERE effect_key = $1 FOR UPDATE`,
          [input.effectKey],
        );
        const existing = result.rows[0];
        if (existing === undefined) throw new Error("effect claim row disappeared");
        if (existing.status === "done") return { state: "done" };
        if (existing.status === "uncertain") return { state: "uncertain" };
        if (existing.status === "processing" && !isStale(existing.updated_at, now())) {
          return {
            retryAt: new Date(Date.parse(existing.updated_at) + 10 * 60_000).toISOString(),
            state: "busy",
          };
        }

        const updated = await client.query<Pick<EffectRow, "attempts"> & Record<string, unknown>>(
          `UPDATE inbox_server.worker_effects
           SET attempts = attempts + 1, status = 'processing', error_class = NULL,
               error_message = NULL, updated_at = $1, finished_at = NULL
           WHERE effect_key = $2 RETURNING attempts`,
          [now().toISOString(), input.effectKey],
        );
        const row = updated.rows[0];
        if (row === undefined) throw new Error("effect claim row disappeared");
        return { attempts: Number(row.attempts), state: "claimed" };
      });
    },

    async consumeRateLimit(input) {
      return withTransaction(options.pool, async (client) => {
        const currentTime = now();
        const timestamp = currentTime.toISOString();
        const expiresAt = new Date(
          currentTime.getTime() + input.windowSeconds * 1_000,
        ).toISOString();
        const inserted = await client.query<RateLimitRow>(
          `INSERT INTO inbox_server.worker_rate_limits
           (scope, bucket_key, count, expires_at, updated_at)
           VALUES ($1, $2, 1, $3, $4)
           ON CONFLICT (scope, bucket_key) DO NOTHING
           RETURNING count, expires_at`,
          [input.scope, input.bucketKey, expiresAt, timestamp],
        );
        if (inserted.rows[0] !== undefined) {
          return { allowed: true, count: Number(inserted.rows[0].count) };
        }

        const result = await client.query<RateLimitRow>(
          `SELECT count, expires_at FROM inbox_server.worker_rate_limits
           WHERE scope = $1 AND bucket_key = $2 FOR UPDATE`,
          [input.scope, input.bucketKey],
        );
        const current = result.rows[0];
        if (current === undefined) throw new Error("rate limit row disappeared");
        if (Date.parse(current.expires_at) <= currentTime.getTime()) {
          await client.query(
            `UPDATE inbox_server.worker_rate_limits
             SET count = 1, expires_at = $1, updated_at = $2
             WHERE scope = $3 AND bucket_key = $4`,
            [expiresAt, timestamp, input.scope, input.bucketKey],
          );
          return { allowed: true, count: 1 };
        }

        const count = Number(current.count);
        if (count >= input.limit) {
          return { allowed: false, count, retryAt: current.expires_at };
        }
        await client.query(
          `UPDATE inbox_server.worker_rate_limits
           SET count = count + 1, updated_at = $1
           WHERE scope = $2 AND bucket_key = $3`,
          [timestamp, input.scope, input.bucketKey],
        );
        return { allowed: true, count: count + 1 };
      });
    },

    async consumeRateLimits(inputs: readonly RateLimitInput[]) {
      if (inputs.length === 0) return { allowed: true, counts: {} };
      const batchScope = [...new Set(inputs.map((input) => input.scope))].sort().join("|");
      return withTransaction(options.pool, async (client) => {
        // ponytail: hash collisions only serialize unrelated batches; replace with per-scope lock rows if throughput matters.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [batchScope]);
        const result = await client.query<RateLimitBatchRow>(
          `SELECT state, version FROM inbox_server.worker_rate_limit_batches
           WHERE scope = $1 FOR UPDATE`,
          [batchScope],
        );
        const row = result.rows[0];
        const states = row ? JSON.parse(row.state) as RateLimitState[] : [];
        const currentTime = now();
        const decision = decideRateLimitBatch(inputs, states, currentTime);
        if (!decision.allowed) {
          return { allowed: false, counts: decision.counts, retryAt: decision.retryAt };
        }

        const timestamp = currentTime.toISOString();
        if (row) {
          const updated = await client.query<Pick<RateLimitBatchRow, "version"> & Record<string, unknown>>(
            `UPDATE inbox_server.worker_rate_limit_batches
             SET state = $1, version = version + 1, updated_at = $2
             WHERE scope = $3 AND version = $4 RETURNING version`,
            [JSON.stringify(decision.nextStates), timestamp, batchScope, row.version],
          );
          if (updated.rows[0] === undefined) throw new Error("rate limit batch contention");
        } else {
          const inserted = await client.query(
            `INSERT INTO inbox_server.worker_rate_limit_batches
             (scope, state, version, updated_at) VALUES ($1, $2, 1, $3)
             ON CONFLICT (scope) DO NOTHING RETURNING version`,
            [batchScope, JSON.stringify(decision.nextStates), timestamp],
          );
          if (inserted.rows.length === 0) throw new Error("rate limit batch contention");
        }
        return { allowed: true, counts: decision.counts };
      });
    },

    async finishEffect(effectKey, input) {
      const timestamp = now().toISOString();
      const client = await options.pool.connect();
      try {
        await client.query(
          `UPDATE inbox_server.worker_effects
           SET status = $1, error_class = $2, error_message = $3,
               updated_at = $4, finished_at = $5 WHERE effect_key = $6`,
          [
            input.status,
            input.errorClass ?? null,
            input.errorMessage?.slice(0, 500) ?? null,
            timestamp,
            input.status === "failed" ? null : timestamp,
            effectKey,
          ],
        );
      } finally {
        await client.release();
      }
    },
  };
}

function isStale(updatedAt: string, current: Date): boolean {
  return current.getTime() - Date.parse(updatedAt) > 10 * 60 * 1_000;
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
