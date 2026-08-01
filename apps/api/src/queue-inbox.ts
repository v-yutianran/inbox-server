export interface InboxLease {
  readonly attempts: number;
  readonly body: unknown;
  readonly id: string;
  readonly leaseId: string;
  readonly timestampMs: number;
}

export interface InboxBatch {
  readonly backlogCount: number;
  readonly messages: readonly InboxLease[];
}

export interface InboxSettlement {
  readonly acks: readonly string[];
  readonly retries: readonly {
    readonly delaySeconds?: number;
    readonly leaseId: string;
  }[];
}

export interface QueueInboxService {
  pull(options: {
    readonly batchSize: number;
    readonly visibilityTimeoutMs: number;
  }): Promise<InboxBatch>;
  settle(settlement: InboxSettlement): Promise<void>;
  stage(messages: readonly {
    readonly body: unknown;
    readonly id: string;
    readonly timestampMs: number;
  }[]): Promise<void>;
}

export function createQueueInboxServiceFromBindings(
  bindings: Pick<ApiBindings, "DB">,
): QueueInboxService {
  return createQueueInboxService({ database: bindings.DB });
}

interface InboxRow {
  readonly attempts: number;
  readonly body: string;
  readonly message_id: string;
  readonly timestamp_ms: number;
}

export function createQueueInboxService(options: {
  readonly database: D1Database;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}): QueueInboxService {
  const now = options.now ?? (() => new Date());
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());

  return {
    async pull(input) {
      const current = now();
      const timestamp = current.toISOString();
      await options.database
        .prepare(
          `UPDATE worker_inbox
           SET status = 'queued', lease_id = NULL, lease_until = NULL,
               available_at = ?, updated_at = ?
           WHERE status = 'leased' AND lease_until <= ?`,
        )
        .bind(timestamp, timestamp, timestamp)
        .run();
      const rows = await options.database
        .prepare(
          `SELECT attempts, body, message_id, timestamp_ms
           FROM worker_inbox
           WHERE status = 'queued' AND available_at <= ?
           ORDER BY created_at, message_id
           LIMIT ?`,
        )
        .bind(timestamp, input.batchSize)
        .all<InboxRow>();
      const messages: InboxLease[] = [];
      for (const row of rows.results) {
        const leaseId = randomUuid();
        const leaseUntil = new Date(
          current.getTime() + input.visibilityTimeoutMs,
        ).toISOString();
        const claimed = await options.database
          .prepare(
            `UPDATE worker_inbox
             SET status = 'leased', attempts = attempts + 1, lease_id = ?,
                 lease_until = ?, updated_at = ?
             WHERE message_id = ? AND status = 'queued'`,
          )
          .bind(leaseId, leaseUntil, timestamp, row.message_id)
          .run();
        if (Number(claimed.meta.changes ?? 0) !== 1) continue;
        messages.push({
          attempts: row.attempts + 1,
          body: JSON.parse(row.body) as unknown,
          id: row.message_id,
          leaseId,
          timestampMs: row.timestamp_ms,
        });
      }
      const count = await options.database
        .prepare("SELECT COUNT(*) AS count FROM worker_inbox")
        .first<{ count: number }>();
      return { backlogCount: Number(count?.count ?? 0), messages };
    },

    async settle(settlement) {
      assertDistinctLeases(settlement);
      const timestamp = now().toISOString();
      const statements: D1PreparedStatement[] = settlement.acks.map((leaseId) =>
        options.database
          .prepare("DELETE FROM worker_inbox WHERE lease_id = ? AND status = 'leased'")
          .bind(leaseId),
      );
      for (const retry of settlement.retries) {
        const availableAt = new Date(
          Date.parse(timestamp) + (retry.delaySeconds ?? 0) * 1_000,
        ).toISOString();
        statements.push(
          options.database
            .prepare(
              `UPDATE worker_inbox
               SET status = 'queued', lease_id = NULL, lease_until = NULL,
                   available_at = ?, updated_at = ?
               WHERE lease_id = ? AND status = 'leased'`,
            )
            .bind(availableAt, timestamp, retry.leaseId),
        );
      }
      if (statements.length > 0) await options.database.batch(statements);
    },

    async stage(messages) {
      if (messages.length === 0) return;
      const timestamp = now().toISOString();
      await options.database.batch(
        messages.map((message) =>
          options.database
            .prepare(
              `INSERT OR IGNORE INTO worker_inbox
               (message_id, body, status, attempts, available_at, timestamp_ms,
                created_at, updated_at)
               VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)`,
            )
            .bind(
              message.id,
              JSON.stringify(message.body) ?? "null",
              timestamp,
              message.timestampMs,
              timestamp,
              timestamp,
            ),
        ),
      );
    },
  };
}

function assertDistinctLeases(settlement: InboxSettlement): void {
  const acknowledged = new Set(settlement.acks);
  for (const retry of settlement.retries) {
    if (acknowledged.has(retry.leaseId)) {
      throw new Error("lease cannot be acknowledged and retried");
    }
  }
}
import type { ApiBindings } from "./auth.js";
