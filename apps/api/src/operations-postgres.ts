import type { OperationsOverview } from "./operations.js";
import { sourceNames } from "@inbox/domain";
import {
  buildCollectionJobs,
  normalizeOverviewStatus,
  operationsOverviewSchema,
  resolveWorkerHeartbeat,
  syncJobSchema,
  SCHEDULER_INTERVAL_SECONDS,
  type ArticleEvent,
  type OperationsService,
  type SyncJob,
  type SyncResponse,
} from "./operations.js";
import type { QueueProducer } from "./queue-producer.js";
import type { PostgresPool } from "./queue-inbox-postgres.js";
import {
  readLatestWorkerHeartbeat,
  type WorkerHeartbeatCache,
} from "./heartbeat-cache.js";

interface SnapshotRow extends Record<string, unknown> {
  readonly payload: string;
}

export function createPostgresOperationsSnapshotStore(
  pool: PostgresPool,
  now: () => Date = () => new Date(),
) {
  return {
    async readSnapshot(): Promise<OperationsOverview | null> {
      return withClient(pool, async (client) => {
        const result = await client.query<SnapshotRow>(
          `SELECT payload FROM inbox_server.operations_snapshots WHERE id = $1`,
          ["current"],
        );
        const row = result.rows[0];
        return row === undefined
          ? null
          : operationsOverviewSchema.parse(JSON.parse(row.payload) as unknown);
      });
    },

    async replaceSnapshot(snapshot: OperationsOverview): Promise<void> {
      const validated = operationsOverviewSchema.parse(snapshot);
      const values = ["current", JSON.stringify(validated), now().toISOString()];
      await withClient(pool, async (client) => {
        await client.query(
          `INSERT INTO inbox_server.operations_snapshots (id, payload, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
          values,
        );
      });
    },
  };
}

export function createPostgresOperationsService(options: {
  readonly pool: PostgresPool;
  readonly producer: QueueProducer;
  readonly now?: () => Date;
  readonly heartbeatCache?: WorkerHeartbeatCache | undefined;
  readonly randomUuid?: () => string;
  readonly schedulerEnabled?: boolean;
  readonly shadowMode?: boolean;
}): OperationsService & {
  readSnapshot(): Promise<OperationsOverview | null>;
} {
  const now = options.now ?? (() => new Date());
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
  const schedulerEnabled = options.schedulerEnabled ?? false;
  const shadowMode = options.shadowMode ?? true;
  const snapshots = createPostgresOperationsSnapshotStore(options.pool, now);

  async function getOverview(): Promise<OperationsOverview> {
    const stored = await snapshots.readSnapshot();
    const snapshot = stored ?? emptyOverview(now(), schedulerEnabled);
    const currentJobs = await listSyncJobs(10);
    const mergedJobs = [...currentJobs, ...snapshot.sync_jobs]
      .filter((job, index, jobs) => jobs.findIndex(({ id }) => id === job.id) === index)
      .slice(0, 10);
    const heartbeat = await readLatestWorkerHeartbeat({
      cache: options.heartbeatCache,
      now: now(),
      pool: options.pool,
    });
    const normalized = normalizeOverviewStatus(
      {
        ...snapshot,
        sync_jobs: mergedJobs,
        worker: resolveWorkerHeartbeat(snapshot.worker, heartbeat?.last_seen_at ?? null),
      },
      now(),
      schedulerEnabled,
    );
    console.log(JSON.stringify({
      description: "已基于 PostgreSQL 最新心跳解析 worker 状态",
      event: "operations.worker_status.resolved",
      lastHeartbeatAt: normalized.worker.last_heartbeat_at,
      online: normalized.worker.online,
    }));
    return normalized;
  }

  async function listArticleEvents(limit: number): Promise<readonly ArticleEvent[]> {
    return (await getOverview()).article_events.slice(0, limit);
  }

  async function listSyncJobs(limit: number): Promise<readonly SyncJob[]> {
    return withClient(options.pool, async (client) => {
      const result = await client.query<SyncJobRow>(
        `SELECT error, finished_at, id, started_at, stats, status, triggered_by
         FROM inbox_server.sync_jobs ORDER BY started_at DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) =>
        syncJobSchema.parse({
          error: row.error,
          finished_at: row.finished_at,
          id: row.id,
          started_at: row.started_at,
          stats: JSON.parse(row.stats) as unknown,
          status: row.status,
          triggered_by: row.triggered_by,
        }),
      );
    });
  }

  async function requestSync(triggeredBy: "manual" | "schedule"): Promise<SyncResponse> {
    const createdAt = now().toISOString();
    const overview = await getOverview();
    const enabledSources = sourceNames.filter(
      (source) => overview.channels.sources[source]?.enabled === true,
    );
    const syncJobId = randomUuid();
    const jobs = buildCollectionJobs({
      createdAt,
      randomUuid,
      runId: syncJobId,
      shadow: shadowMode,
      sources: enabledSources,
      triggeredBy,
    });
    const queued = Object.fromEntries(enabledSources.map((source) => [source, 1]));
    await withTransaction(options.pool, async (client) => {
      await client.query(
        `INSERT INTO inbox_server.sync_jobs
         (id, triggered_by, status, stats, started_at, finished_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          syncJobId,
          triggeredBy === "schedule" ? "scheduler" : "manual",
          jobs.length === 0 ? "done" : "running",
          JSON.stringify({ queued }),
          createdAt,
          jobs.length === 0 ? createdAt : null,
          null,
        ],
      );
    });
    try {
      await options.producer.sendBatch(jobs);
    } catch (error: unknown) {
      await withTransaction(options.pool, async (client) => {
        await client.query(
          `UPDATE inbox_server.sync_jobs
           SET error = $1, finished_at = $2, status = 'failed' WHERE id = $3`,
          [
            error instanceof Error ? error.message : "queue publish failed",
            now().toISOString(),
            syncJobId,
          ],
        );
      });
      throw error;
    }
    return { results: { queued }, status: "ok" };
  }

  return {
    ...snapshots,
    getOverview,
    listArticleEvents,
    listSyncJobs,
    requestManualSync: () => requestSync("manual"),
    requestScheduledSync: () => requestSync("schedule"),
  };
}

interface SyncJobRow extends Record<string, unknown> {
  readonly error: string | null;
  readonly finished_at: string | null;
  readonly id: string;
  readonly started_at: string;
  readonly stats: string;
  readonly status: string;
  readonly triggered_by: string;
}

function emptyOverview(now: Date, schedulerEnabled: boolean): OperationsOverview {
  const emptyQueue = { dlq: 0, done: 0, pending: 0 } as const;
  return {
    article_events: [],
    channels: { destinations: {}, sources: {} },
    generated_at: now.toISOString(),
    queues: {
      article: emptyQueue,
      file: emptyQueue,
      link: emptyQueue,
      text: emptyQueue,
    },
    scheduler: {
      enabled: schedulerEnabled,
      interval_seconds: SCHEDULER_INTERVAL_SECONDS,
      next_run_at: null,
    },
    server: { online: true },
    status: "ok",
    sync_jobs: [],
    worker: { last_heartbeat_at: null, online: false },
  };
}

async function withClient<T>(
  pool: PostgresPool,
  operation: (client: Awaited<ReturnType<PostgresPool["connect"]>>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    await client.release();
  }
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
