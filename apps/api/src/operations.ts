import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { parseQueueJob, sourceNames, type QueueJob } from "@inbox/domain";

import type { ApiBindings } from "./auth.js";
import { createQueueProducer, type QueueProducer } from "./queue-producer.js";
import { operationsSnapshots, syncJobs } from "./schema.js";

const queueStatsSchema = z
  .object({
    dlq: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();

const channelSummarySchema = z
  .object({
    credential_name: z.string().nullable().optional(),
    enabled: z.boolean(),
    item_kind: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
  })
  .strict();

export const syncJobSchema = z
  .object({
    error: z.string().nullable(),
    finished_at: z.string().datetime({ offset: true }).nullable(),
    id: z.string().min(1),
    started_at: z.string().datetime({ offset: true }),
    stats: z.record(z.string(), z.unknown()),
    status: z.string().min(1),
    triggered_by: z.string().min(1),
  })
  .strict();

export const articleEventSchema = z
  .object({
    filename: z.string().nullable(),
    id: z.number().int(),
    occurred_at: z.string().datetime({ offset: true }),
    reason: z.string().nullable(),
    source_url: z.string(),
    status: z.string().min(1),
    title: z.string(),
    url_fingerprint: z.string(),
  })
  .strict();

export const operationsOverviewSchema = z
  .object({
    article_events: z.array(articleEventSchema),
    channels: z
      .object({
        destinations: z.record(z.string(), channelSummarySchema),
        sources: z.record(z.string(), channelSummarySchema),
      })
      .strict(),
    generated_at: z.string().datetime({ offset: true }),
    queues: z
      .object({
        article: queueStatsSchema,
        file: queueStatsSchema,
        link: queueStatsSchema,
        text: queueStatsSchema,
      })
      .strict(),
    scheduler: z
      .object({
        enabled: z.boolean(),
        interval_seconds: z.number().int().positive(),
        next_run_at: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
    server: z.object({ online: z.boolean() }).strict(),
    status: z.literal("ok"),
    sync_jobs: z.array(syncJobSchema),
    worker: z
      .object({
        last_heartbeat_at: z.string().datetime({ offset: true }).nullable(),
        online: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type ArticleEvent = z.infer<typeof articleEventSchema>;
export type OperationsOverview = z.infer<typeof operationsOverviewSchema>;
export type SyncJob = z.infer<typeof syncJobSchema>;
export type SyncResponse = { readonly results: Record<string, unknown>; readonly status: "ok" };

export interface OperationsService {
  getOverview(): Promise<OperationsOverview>;
  listArticleEvents(limit: number): Promise<readonly ArticleEvent[]>;
  listSyncJobs(limit: number): Promise<readonly SyncJob[]>;
  replaceSnapshot(snapshot: OperationsOverview): Promise<void>;
  requestManualSync(): Promise<SyncResponse>;
  requestScheduledSync(): Promise<SyncResponse>;
}

interface OperationsServiceOptions {
  readonly database: D1Database;
  readonly now?: () => Date;
  readonly producer: QueueProducer;
  readonly randomUuid?: () => string;
  readonly schedulerEnabled?: boolean;
}

export function createOperationsServiceFromBindings(bindings: ApiBindings): OperationsService {
  return createD1OperationsService({
    database: bindings.DB,
    producer: createQueueProducer(bindings.JOBS),
    schedulerEnabled: bindings.SCHEDULE_ENABLED === "true",
  });
}

export function createD1OperationsService({
  database,
  now = () => new Date(),
  producer,
  randomUuid = () => crypto.randomUUID(),
  schedulerEnabled = false,
}: OperationsServiceOptions): OperationsService {
  const db = drizzle(database, { schema: { operationsSnapshots, syncJobs } });

  async function getOverview(): Promise<OperationsOverview> {
    const snapshotRow = await db.query.operationsSnapshots.findFirst({
      where: eq(operationsSnapshots.id, "current"),
    });
    const snapshot = snapshotRow
      ? operationsOverviewSchema.parse(snapshotRow.payload)
      : emptyOverview(now(), schedulerEnabled);
    const currentJobs = await listSyncJobs(10);
    const mergedJobs = [...currentJobs, ...snapshot.sync_jobs]
      .filter((job, index, jobs) => jobs.findIndex(({ id }) => id === job.id) === index)
      .slice(0, 10);
    return normalizeOverviewStatus(
      { ...snapshot, sync_jobs: mergedJobs },
      now(),
      schedulerEnabled,
    );
  }

  async function listSyncJobs(limit: number): Promise<readonly SyncJob[]> {
    const rows = await db.select().from(syncJobs).orderBy(desc(syncJobs.startedAt)).limit(limit);
    return rows.map((row) =>
      syncJobSchema.parse({
        error: row.error,
        finished_at: row.finishedAt,
        id: row.id,
        started_at: row.startedAt,
        stats: row.stats,
        status: row.status,
        triggered_by: row.triggeredBy,
      }),
    );
  }

  async function requestSync(triggeredBy: "manual" | "schedule"): Promise<SyncResponse> {
    const createdAt = now().toISOString();
    const overview = await getOverview();
    const enabledSources = sourceNames.filter(
      (source) => overview.channels.sources[source]?.enabled === true,
    );
    const syncJobId = randomUuid();
    const jobs: readonly QueueJob[] = enabledSources.map((source) =>
      parseQueueJob({
        createdAt,
        dedupeKey: `collect:${source}:${syncJobId}`,
        jobId: randomUuid(),
        kind: "collect-source",
        payload: { shadow: true, source, triggeredBy },
        schemaVersion: 1,
      }),
    );
    const queued = Object.fromEntries(enabledSources.map((source) => [source, 1]));
    await db.insert(syncJobs).values({
      error: null,
      finishedAt: jobs.length === 0 ? createdAt : null,
      id: syncJobId,
      startedAt: createdAt,
      stats: { queued },
      status: jobs.length === 0 ? "done" : "running",
      triggeredBy: triggeredBy === "schedule" ? "scheduler" : "manual",
    });
    try {
      await producer.sendBatch(jobs);
    } catch (error: unknown) {
      await db
        .update(syncJobs)
        .set({
          error: error instanceof Error ? error.message : "queue publish failed",
          finishedAt: now().toISOString(),
          status: "failed",
        })
        .where(eq(syncJobs.id, syncJobId));
      throw error;
    }
    return { results: { queued }, status: "ok" };
  }

  return {
    getOverview,
    async listArticleEvents(limit) {
      return (await getOverview()).article_events.slice(0, limit);
    },
    listSyncJobs,
    async replaceSnapshot(snapshot) {
      const validated = operationsOverviewSchema.parse(snapshot);
      await db
        .insert(operationsSnapshots)
        .values({ id: "current", payload: validated, updatedAt: now().toISOString() })
        .onConflictDoUpdate({
          set: { payload: validated, updatedAt: now().toISOString() },
          target: operationsSnapshots.id,
        });
    },
    requestManualSync: () => requestSync("manual"),
    requestScheduledSync: () => requestSync("schedule"),
  };
}

export function normalizeOverviewStatus(
  overview: OperationsOverview,
  now: Date,
  schedulerEnabled: boolean,
): OperationsOverview {
  const heartbeatAt = overview.worker.last_heartbeat_at
    ? Date.parse(overview.worker.last_heartbeat_at)
    : Number.NaN;
  const heartbeatAge = now.getTime() - heartbeatAt;
  const workerOnline =
    overview.worker.online && heartbeatAge >= -30_000 && heartbeatAge <= 90_000;
  return {
    ...overview,
    generated_at: now.toISOString(),
    scheduler: { ...overview.scheduler, enabled: schedulerEnabled },
    worker: { ...overview.worker, online: workerOnline },
  };
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
    scheduler: { enabled: schedulerEnabled, interval_seconds: 600, next_run_at: null },
    server: { online: true },
    status: "ok",
    sync_jobs: [],
    worker: { last_heartbeat_at: null, online: false },
  };
}
