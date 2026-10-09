import type {
  InboxBatch,
  InboxLease,
  InboxSettlement,
  QueueInboxService,
} from "./queue-inbox.js";

interface QueryResult<Row> {
  readonly rows: readonly Row[];
}

interface PostgresClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  release(error?: Error): Promise<void> | void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

interface InboxRow extends Record<string, unknown> {
  readonly attempts: number | string;
  readonly body: string;
  readonly message_id: string;
  readonly timestamp_ms: number | string;
}

export function createQueueInboxPostgresService(options: {
  readonly pool: PostgresPool;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}): QueueInboxService {
  const now = options.now ?? (() => new Date());
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());

  return {
    async pull(input): Promise<InboxBatch> {
      const current = now();
      const timestamp = current.toISOString();
      return withTransaction(options.pool, async (client) => {
        await client.query(
          `UPDATE inbox_server.worker_inbox
           SET status = 'queued', lease_id = NULL, lease_until = NULL,
               available_at = $1, updated_at = $1
           WHERE status = 'leased' AND lease_until <= $1`,
          [timestamp],
        );
        const candidates = await client.query<InboxRow>(
          `SELECT message_id, attempts, body, timestamp_ms
           FROM inbox_server.worker_inbox
           WHERE status = 'queued' AND available_at <= $1
           ORDER BY created_at, message_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [timestamp, input.batchSize],
        );
        const messages: InboxLease[] = [];
        const leaseUntil = new Date(
          current.getTime() + input.visibilityTimeoutMs,
        ).toISOString();
        for (const candidate of candidates.rows) {
          const leaseId = randomUuid();
          const claimed = await client.query<InboxRow>(
            `UPDATE inbox_server.worker_inbox
             SET status = 'leased', attempts = attempts + 1, lease_id = $1,
                 lease_until = $2, updated_at = $3
             WHERE message_id = $4 AND status = 'queued'
             RETURNING attempts, body, message_id, timestamp_ms`,
            [leaseId, leaseUntil, timestamp, candidate.message_id],
          );
          const row = claimed.rows[0];
          if (row === undefined) continue;
          messages.push({
            attempts: Number(row.attempts),
            body: JSON.parse(row.body) as unknown,
            id: row.message_id,
            leaseId,
            timestampMs: Number(row.timestamp_ms),
          });
        }
        const count = await client.query<{ count: number | string } & Record<string, unknown>>(
          "SELECT COUNT(*) AS count FROM inbox_server.worker_inbox",
        );
        return { backlogCount: Number(count.rows[0]?.count ?? 0), messages };
      });
    },

    async settle(settlement: InboxSettlement): Promise<void> {
      assertDistinctLeases(settlement);
      if (settlement.acks.length === 0 && settlement.retries.length === 0) return;
      const timestamp = now().toISOString();
      await withTransaction(options.pool, async (client) => {
        for (const leaseId of settlement.acks) {
          await client.query(
            "DELETE FROM inbox_server.worker_inbox WHERE lease_id = $1 AND status = 'leased'",
            [leaseId],
          );
        }
        for (const retry of settlement.retries) {
          const availableAt = new Date(
            Date.parse(timestamp) + (retry.delaySeconds ?? 0) * 1_000,
          ).toISOString();
          await client.query(
            `UPDATE inbox_server.worker_inbox
             SET status = 'queued', lease_id = NULL, lease_until = NULL,
                 available_at = $1, updated_at = $2
             WHERE lease_id = $3 AND status = 'leased'`,
            [availableAt, timestamp, retry.leaseId],
          );
        }
      });
    },

    async stage(messages): Promise<void> {
      if (messages.length === 0) return;
      const timestamp = now().toISOString();
      await withTransaction(options.pool, async (client) => {
        for (const message of messages) {
          await client.query(
            `INSERT INTO inbox_server.worker_inbox
             (message_id, body, status, attempts, available_at, timestamp_ms,
              created_at, updated_at)
             VALUES ($1, $2, 'queued', 0, $3, $4, $3, $3)
             ON CONFLICT (message_id) DO NOTHING`,
            [message.id, JSON.stringify(message.body) ?? "null", timestamp, message.timestampMs],
          );
        }
      });
    },
  };
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

function assertDistinctLeases(settlement: InboxSettlement): void {
  const acknowledged = new Set(settlement.acks);
  for (const retry of settlement.retries) {
    if (acknowledged.has(retry.leaseId)) {
      throw new Error("lease cannot be acknowledged and retried");
    }
  }
}
