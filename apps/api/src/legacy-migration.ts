import { queueJobSchema, type QueueJob } from "@inbox/domain";
import { z } from "zod";

import type { ApiBindings } from "./auth.js";
import { encryptJson } from "./credential-crypto.js";
import { createQueueProducer, type QueueProducer } from "./queue-producer.js";

const timestamp = z.string().datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const itemKind = z.enum(["link", "text", "file", "article"]);
const postgresSchema = z.object({
  articleEvents: z.array(z.object({
    filename: z.string().nullable(),
    occurredAt: timestamp,
    reason: z.string().nullable(),
    sourceUrl: z.string(),
    status: z.string(),
    title: z.string(),
    urlFingerprint: z.string(),
  })),
  baselines: z.array(z.object({ knownKeys: z.array(z.string()), source: z.string() })),
  credentials: z.array(z.object({
    kind: z.string(),
    name: z.string(),
    payload: z.unknown(),
    platform: z.string(),
  })),
  didaSyncStates: z.array(z.object({
    lastSync: nullableTimestamp,
    savedTitles: z.array(z.string()),
    tokenHash: z.string(),
    updatedAt: timestamp.nullable(),
  })),
  loginSessions: z.array(z.object({
    expiresAt: timestamp,
    lastError: z.string().nullable(),
    lastUsedAt: nullableTimestamp,
    platform: z.string(),
    state: z.unknown(),
    status: z.string(),
  })),
  subscriptions: z.array(z.object({
    createdAt: timestamp,
    currentPeriodEnd: nullableTimestamp,
    id: z.number().int(),
    plan: z.string().nullable(),
    seats: z.number().int(),
    status: z.string().nullable(),
  })),
  syncJobs: z.array(z.object({
    error: z.string().nullable(),
    finishedAt: nullableTimestamp,
    id: z.string(),
    startedAt: timestamp,
    stats: z.record(z.string(), z.unknown()),
    status: z.string(),
    triggeredBy: z.string(),
  })),
  telegramOffsets: z.array(z.object({
    tokenHash: z.string(),
    updateId: z.number().int(),
    updatedAt: timestamp.nullable(),
  })),
});
const redisSchema = z.object({
  deadLetters: z.array(z.object({
    attempts: z.number().int().nonnegative(),
    createdAt: timestamp,
    errorClass: z.string(),
    errorMessage: z.string(),
    itemKind,
    messageId: z.string(),
    payloadDigest: z.string(),
  })),
  doneJobs: z.array(z.object({
    completedAt: timestamp,
    dedupeKey: z.string(),
    itemKind,
    jobId: z.string(),
  })),
  pendingJobs: z.array(queueJobSchema),
  rateLimits: z.array(z.object({
    bucketKey: z.string(),
    count: z.number().int().nonnegative(),
    expiresAt: timestamp,
    scope: z.string(),
  })),
});

export const legacySnapshotSchema = z.object({
  exportedAt: timestamp,
  postgres: postgresSchema,
  redis: redisSchema,
  schemaVersion: z.literal(1),
});

export type LegacySnapshot = z.infer<typeof legacySnapshotSchema>;

export interface LegacyMigrationService {
  importSnapshot(snapshot: unknown): Promise<{
    readonly imported: Record<string, number>;
    readonly publishedPendingJobs: number;
    readonly totals: Record<string, number>;
  }>;
}

export function createLegacyMigrationServiceFromBindings(
  bindings: ApiBindings,
): LegacyMigrationService {
  return createLegacyMigrationService({
    database: bindings.DB,
    encryptionKey: bindings.STATE_ENCRYPTION_KEY ?? "",
    producer: createQueueProducer(bindings.JOBS),
  });
}

export function createLegacyMigrationService(options: {
  readonly database: D1Database;
  readonly encryptionKey: string;
  readonly producer: QueueProducer;
}): LegacyMigrationService {
  return {
    async importSnapshot(input) {
      const snapshot = legacySnapshotSchema.parse(input);
      const statements: D1PreparedStatement[] = [];
      const add = (sql: string, ...bindings: unknown[]) => {
        statements.push(options.database.prepare(sql).bind(...bindings));
      };

      for (const row of snapshot.postgres.telegramOffsets) {
        const updatedAt = row.updatedAt ?? snapshot.exportedAt;
        add(
          `INSERT INTO telegram_offsets (bot_token_hash, update_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(bot_token_hash) DO UPDATE SET update_id = excluded.update_id,
             updated_at = excluded.updated_at`,
          row.tokenHash, row.updateId, updatedAt,
        );
        add(
          `INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          `telegram:offset:${row.tokenHash.slice(0, 16)}`,
          JSON.stringify({ offset: row.updateId }),
          updatedAt,
        );
      }
      for (const row of snapshot.postgres.didaSyncStates) {
        const updatedAt = row.updatedAt ?? snapshot.exportedAt;
        add(
          `INSERT INTO dida_sync_states
           (token_hash, saved_titles, last_sync, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET saved_titles = excluded.saved_titles,
             last_sync = excluded.last_sync, updated_at = excluded.updated_at`,
          row.tokenHash, JSON.stringify(row.savedTitles), row.lastSync, updatedAt,
        );
        add(
          `INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          `dida:saved:${row.tokenHash.slice(0, 16)}`,
          JSON.stringify({ savedTitles: row.savedTitles }),
          updatedAt,
        );
      }
      for (const row of snapshot.postgres.baselines) {
        add(
          `INSERT INTO incremental_baselines (source, known_keys, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(source) DO UPDATE SET known_keys = excluded.known_keys,
             updated_at = excluded.updated_at`,
          row.source, JSON.stringify(row.knownKeys), snapshot.exportedAt,
        );
        add(
          `INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          `baseline:${row.source}`,
          JSON.stringify({ knownKeys: row.knownKeys }),
          snapshot.exportedAt,
        );
      }
      for (const row of snapshot.postgres.credentials) {
        const encrypted = await encryptJson(row.payload, options.encryptionKey);
        add(
          `INSERT INTO credentials
           (name, platform, kind, payload_encrypted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET platform = excluded.platform, kind = excluded.kind,
             payload_encrypted = excluded.payload_encrypted, updated_at = excluded.updated_at`,
          row.name, row.platform, row.kind, encrypted.buffer,
          snapshot.exportedAt, snapshot.exportedAt,
        );
      }
      for (const row of snapshot.postgres.loginSessions) {
        const encrypted = await encryptJson(row.state, options.encryptionKey);
        add(
          `INSERT INTO login_sessions
           (platform, storage_state_encrypted, status, expires_at, last_used_at,
            last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform) DO UPDATE SET
             storage_state_encrypted = excluded.storage_state_encrypted,
             status = excluded.status, expires_at = excluded.expires_at,
             last_used_at = excluded.last_used_at, last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
          row.platform, encrypted.buffer, row.status, row.expiresAt, row.lastUsedAt,
          row.lastError, snapshot.exportedAt, snapshot.exportedAt,
        );
      }
      for (const row of snapshot.postgres.syncJobs) {
        add(
          `INSERT INTO sync_jobs
           (id, triggered_by, status, stats, started_at, finished_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, stats = excluded.stats,
             finished_at = excluded.finished_at, error = excluded.error`,
          row.id, row.triggeredBy, row.status, JSON.stringify(row.stats), row.startedAt,
          row.finishedAt, row.error,
        );
      }
      for (const row of snapshot.postgres.articleEvents) {
        add(
          `INSERT OR IGNORE INTO article_archive_events
           (source_url, url_fingerprint, title, status, reason, filename, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          row.sourceUrl, row.urlFingerprint, row.title, row.status, row.reason,
          row.filename, row.occurredAt,
        );
      }
      for (const row of snapshot.postgres.subscriptions) {
        add(
          `INSERT INTO subscriptions
           (id, plan, status, seats, current_period_end, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, status = excluded.status,
             seats = excluded.seats, current_period_end = excluded.current_period_end`,
          row.id, row.plan, row.status, row.seats, row.currentPeriodEnd, row.createdAt,
        );
      }
      for (const row of snapshot.redis.doneJobs) {
        add(
          `INSERT INTO worker_jobs
           (dedupe_key, job_id, kind, item_kind, status, attempts, summary,
            created_at, updated_at, finished_at)
           VALUES (?, ?, 'dispatch-item', ?, 'done', 1, '{}', ?, ?, ?)
           ON CONFLICT(dedupe_key) DO NOTHING`,
          row.dedupeKey, row.jobId, row.itemKind, row.completedAt,
          row.completedAt, row.completedAt,
        );
      }
      for (const row of snapshot.redis.deadLetters) {
        add(
          `INSERT INTO worker_dead_letters
           (job_id, dedupe_key, kind, item_kind, attempts, error_class,
            error_message, payload_digest, created_at)
           VALUES (?, ?, 'dispatch-item', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO NOTHING`,
          row.messageId, `legacy-dead:${row.messageId}`, row.itemKind, row.attempts,
          row.errorClass, row.errorMessage, row.payloadDigest, row.createdAt,
        );
      }
      for (const row of snapshot.redis.rateLimits) {
        add(
          `INSERT INTO worker_rate_limits
           (scope, bucket_key, count, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope, bucket_key) DO UPDATE SET count = excluded.count,
             expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
          row.scope, row.bucketKey, row.count, row.expiresAt, snapshot.exportedAt,
        );
      }
      await batchStatements(options.database, statements);

      const pending = await publishPendingOnce(
        options.database,
        options.producer,
        snapshot.redis.pendingJobs,
        snapshot.exportedAt,
      );
      const imported = snapshotCounts(snapshot);
      return {
        imported,
        publishedPendingJobs: pending,
        totals: await databaseCounts(options.database),
      };
    },
  };
}

async function batchStatements(
  database: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<void> {
  for (let index = 0; index < statements.length; index += 100) {
    await database.batch(statements.slice(index, index + 100));
  }
}

async function publishPendingOnce(
  database: D1Database,
  producer: QueueProducer,
  jobs: readonly QueueJob[],
  updatedAt: string,
): Promise<number> {
  const pending: QueueJob[] = [];
  for (const job of jobs) {
    const key = `migration:pending:${job.jobId}`;
    const existing = await database
      .prepare("SELECT 1 AS found FROM worker_state WHERE key = ?")
      .bind(key)
      .first<{ found: number }>();
    if (!existing) pending.push(job);
  }
  if (pending.length === 0) return 0;
  await producer.sendBatch(pending);
  await batchStatements(
    database,
    pending.map((job) =>
      database
        .prepare("INSERT OR IGNORE INTO worker_state (key, value, updated_at) VALUES (?, '{}', ?)")
        .bind(`migration:pending:${job.jobId}`, updatedAt),
    ),
  );
  return pending.length;
}

function snapshotCounts(snapshot: LegacySnapshot): Record<string, number> {
  return {
    articleEvents: snapshot.postgres.articleEvents.length,
    baselines: snapshot.postgres.baselines.length,
    credentials: snapshot.postgres.credentials.length,
    deadLetters: snapshot.redis.deadLetters.length,
    didaSyncStates: snapshot.postgres.didaSyncStates.length,
    doneJobs: snapshot.redis.doneJobs.length,
    loginSessions: snapshot.postgres.loginSessions.length,
    pendingJobs: snapshot.redis.pendingJobs.length,
    rateLimits: snapshot.redis.rateLimits.length,
    subscriptions: snapshot.postgres.subscriptions.length,
    syncJobs: snapshot.postgres.syncJobs.length,
    telegramOffsets: snapshot.postgres.telegramOffsets.length,
  };
}

async function databaseCounts(database: D1Database): Promise<Record<string, number>> {
  const tables = [
    "article_archive_events",
    "credentials",
    "dida_sync_states",
    "incremental_baselines",
    "login_sessions",
    "subscriptions",
    "sync_jobs",
    "telegram_offsets",
    "worker_dead_letters",
    "worker_inbox",
    "worker_jobs",
    "worker_rate_limits",
    "worker_state",
  ] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
    counts[table] = Number(row?.count ?? 0);
  }
  return counts;
}
