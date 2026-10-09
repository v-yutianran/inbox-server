import { describe, expect, it, vi } from "vitest";

import type { OperationsOverview, OperationsService, SyncJob } from "../src/operations";
import {
  createPostgresOperationsService,
  createPostgresOperationsSnapshotStore,
} from "../src/operations-postgres";

const snapshot: OperationsOverview = {
  article_events: [],
  channels: { destinations: {}, sources: {} },
  generated_at: "2026-08-01T02:49:50.000Z",
  queues: {
    article: { dlq: 0, done: 0, pending: 0 },
    file: { dlq: 0, done: 0, pending: 0 },
    link: { dlq: 0, done: 0, pending: 0 },
    text: { dlq: 0, done: 0, pending: 0 },
  },
  scheduler: { enabled: true, interval_seconds: 600, next_run_at: null },
  server: { online: true },
  status: "ok",
  sync_jobs: [],
  worker: { last_heartbeat_at: null, online: false },
};

describe("PostgreSQL operations snapshot store", () => {
  it("reads and validates the current snapshot", async () => {
    const database = scriptedPool(() => ({ rows: [{ payload: JSON.stringify(snapshot) }] }));
    const store = createPostgresOperationsSnapshotStore(database.pool);

    await expect(store.readSnapshot()).resolves.toEqual(snapshot);

    expect(database.calls[0]).toMatchObject({
      sql: expect.stringContaining("FROM inbox_server.operations_snapshots"),
      values: ["current"],
    });
    expect(database.released).toBe(1);
  });

  it("returns null if the current snapshot is missing", async () => {
    const database = scriptedPool(() => ({ rows: [] }));
    const store = createPostgresOperationsSnapshotStore(database.pool);

    await expect(store.readSnapshot()).resolves.toBeNull();
    expect(database.released).toBe(1);
  });

  it("atomically upserts the validated singleton snapshot", async () => {
    const database = scriptedPool(() => ({ rows: [] }));
    const updatedAt = new Date("2026-08-01T03:00:00.000Z");
    const store = createPostgresOperationsSnapshotStore(database.pool, () => updatedAt);

    await store.replaceSnapshot(snapshot);

    expect(database.calls[0]?.sql).toContain("INSERT INTO inbox_server.operations_snapshots");
    expect(database.calls[0]?.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(database.calls[0]?.values).toEqual([
      "current",
      JSON.stringify(snapshot),
      updatedAt.toISOString(),
    ]);
    expect(database.released).toBe(1);
  });

  it("rejects invalid snapshots before connecting", async () => {
    const database = scriptedPool(() => ({ rows: [] }));
    const store = createPostgresOperationsSnapshotStore(database.pool);

    await expect(
      store.replaceSnapshot({ status: "broken" } as unknown as OperationsOverview),
    ).rejects.toThrow();
    expect(database.calls).toHaveLength(0);
    expect(database.released).toBe(0);
  });

  it("releases the connection when the stored snapshot is invalid", async () => {
    const database = scriptedPool(() => ({ rows: [{ payload: "{}" }] }));
    const store = createPostgresOperationsSnapshotStore(database.pool);

    await expect(store.readSnapshot()).rejects.toThrow();
    expect(database.released).toBe(1);
  });
});

describe("PostgreSQL operations sync jobs", () => {
  it.each([
    { method: "requestManualSync", storedBy: "manual", payloadBy: "manual" },
    { method: "requestScheduledSync", storedBy: "scheduler", payloadBy: "schedule" },
  ] as const)("publishes $method after committing its sync job", async ({ method, storedBy, payloadBy }) => {
    const database = scriptedPool((sql) =>
      sql.includes("FROM inbox_server.operations_snapshots")
        ? { rows: [{ payload: JSON.stringify(withEnabledTelegram(snapshot)) }] }
        : { rows: [] },
    );
    const published: unknown[][] = [];
    const service: OperationsService = createPostgresOperationsService({
      pool: database.pool,
      producer: {
        async sendBatch(jobs) {
          database.events.push("queue:publish");
          published.push([...jobs]);
        },
      },
      now: () => new Date("2026-08-01T03:00:00.000Z"),
      randomUuid: (() => {
        const ids = [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ];
        return () => ids.shift() ?? "00000000-0000-4000-8000-000000000003";
      })(),
      shadowMode: false,
    });
    await expect(service[method]()).resolves.toEqual({
      results: { queued: { telegram: 1 } },
      status: "ok",
    });

    const insert = database.calls.find(({ sql }) => sql.includes("INSERT INTO inbox_server.sync_jobs"));
    expect(insert?.values).toEqual([
      "00000000-0000-4000-8000-000000000001",
      storedBy,
      "running",
      JSON.stringify({ queued: { telegram: 1 } }),
      "2026-08-01T03:00:00.000Z",
      null,
      null,
    ]);
    expect(database.events.indexOf("COMMIT")).toBeLessThan(database.events.indexOf("queue:publish"));
    expect(published).toHaveLength(1);
    expect(published[0]?.[0]).toMatchObject({
      createdAt: "2026-08-01T03:00:00.000Z",
      dedupeKey: "collect:telegram:00000000-0000-4000-8000-000000000001",
      jobId: "00000000-0000-4000-8000-000000000002",
      kind: "collect-source",
      payload: { shadow: false, source: "telegram", triggeredBy: payloadBy },
    });
  });

  it("marks the committed sync job failed after Queue publishing fails, then rethrows", async () => {
    const publishError = new Error("synthetic Queue failure");
    const database = scriptedPool((sql) =>
      sql.includes("FROM inbox_server.operations_snapshots")
        ? { rows: [{ payload: JSON.stringify(withEnabledTelegram(snapshot)) }] }
        : { rows: [] },
    );
    const service: OperationsService = createPostgresOperationsService({
      pool: database.pool,
      producer: {
        async sendBatch() {
          database.events.push("queue:publish");
          throw publishError;
        },
      },
      now: (() => {
        const timestamps = [
          "2026-08-01T03:00:00.000Z",
          "2026-08-01T03:00:01.000Z",
        ];
        return () => new Date(timestamps.shift() ?? "2026-08-01T03:00:01.000Z");
      })(),
      randomUuid: () => "00000000-0000-4000-8000-000000000001",
    });

    await expect(service.requestManualSync()).rejects.toBe(publishError);

    const updateIndex = database.events.findIndex((event) => event.includes("UPDATE inbox_server.sync_jobs"));
    expect(database.events.indexOf("COMMIT")).toBeLessThan(database.events.indexOf("queue:publish"));
    expect(updateIndex).toBeGreaterThan(database.events.indexOf("queue:publish"));
    expect(database.calls.find(({ sql }) => sql.includes("UPDATE inbox_server.sync_jobs"))?.values)
      .toEqual([
        "synthetic Queue failure",
        "2026-08-01T03:00:01.000Z",
        "00000000-0000-4000-8000-000000000001",
      ]);
    expect(database.events.at(-1)).toBe("COMMIT");
  });

  it("lists newest sync jobs and parses their JSON stats", async () => {
    const database = scriptedPool((sql) => sql.includes("FROM inbox_server.sync_jobs")
      ? { rows: [{
          error: null,
          finished_at: null,
          id: "run-id",
          started_at: "2026-08-01T03:00:00.000Z",
          stats: JSON.stringify({ queued: { telegram: 1 } }),
          status: "running",
          triggered_by: "manual",
        }] }
      : { rows: [] });
    const service = createPostgresOperationsService({
      pool: database.pool,
      producer: { async sendBatch() {} },
    });

    await expect(service.listSyncJobs(10)).resolves.toEqual([{
      error: null,
      finished_at: null,
      id: "run-id",
      started_at: "2026-08-01T03:00:00.000Z",
      stats: { queued: { telegram: 1 } },
      status: "running",
      triggered_by: "manual",
    }]);
    expect(database.calls[0]?.sql).toContain("ORDER BY started_at DESC LIMIT $1");
    expect(database.calls[0]?.values).toEqual([10]);
  });
});

describe("PostgreSQL operations overview", () => {
  it("uses a fresh cached heartbeat before querying Neon", async () => {
    const database = scriptedPool(() => ({ rows: [] }));
    const heartbeatCache = {
      get: vi.fn(async () => ({
        details: "{}",
        last_seen_at: "2026-08-01T02:59:55.000Z",
        worker_id: "worker-cache",
      })),
      setIfNewer: vi.fn(async () => undefined),
    };
    const service = createPostgresOperationsService({
      heartbeatCache,
      pool: database.pool,
      producer: { async sendBatch() {} },
      now: () => new Date("2026-08-01T03:00:00.000Z"),
    } as Parameters<typeof createPostgresOperationsService>[0]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(service.getOverview()).resolves.toMatchObject({
        worker: { last_heartbeat_at: "2026-08-01T02:59:55.000Z", online: true },
      });
      expect(heartbeatCache.get).toHaveBeenCalledOnce();
      expect(database.calls.some(({ sql }) => sql.includes("FROM inbox_server.worker_heartbeats"))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("overlays the latest heartbeat and merges current sync jobs before snapshot history", async () => {
    const oldJob = makeSyncJob("old-run");
    const duplicateJob = makeSyncJob("current-run", "2026-08-01T02:59:00.000Z");
    const databaseJob = { ...duplicateJob, status: "done" };
    const firstEvent = makeArticleEvent(1);
    const secondEvent = makeArticleEvent(2);
    const storedSnapshot: OperationsOverview = {
      ...snapshot,
      article_events: [firstEvent, secondEvent],
      sync_jobs: [duplicateJob, oldJob],
      worker: { last_heartbeat_at: "2026-08-01T02:50:00.000Z", online: true },
    };
    const database = scriptedPool((sql) => {
      if (sql.includes("FROM inbox_server.operations_snapshots")) {
        return { rows: [{ payload: JSON.stringify(storedSnapshot) }] };
      }
      if (sql.includes("FROM inbox_server.sync_jobs")) {
        return { rows: [{
          error: null,
          finished_at: null,
          id: databaseJob.id,
          started_at: databaseJob.started_at,
          stats: JSON.stringify(databaseJob.stats),
          status: databaseJob.status,
          triggered_by: databaseJob.triggered_by,
        }] };
      }
      if (sql.includes("FROM inbox_server.worker_heartbeats")) {
        return { rows: [{ last_seen_at: "2026-08-01T02:59:50.000Z" }] };
      }
      return { rows: [] };
    });
    const service = createPostgresOperationsService({
      pool: database.pool,
      producer: { async sendBatch() {} },
      now: () => new Date("2026-08-01T03:00:00.000Z"),
      schedulerEnabled: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const overview = await service.getOverview();
      expect(overview).toMatchObject({
        generated_at: "2026-08-01T03:00:00.000Z",
        scheduler: {
          enabled: true,
          interval_seconds: 3_600,
          next_run_at: "2026-08-01T04:00:00.000Z",
        },
        sync_jobs: [databaseJob, oldJob],
        worker: { last_heartbeat_at: "2026-08-01T02:59:50.000Z", online: true },
      });
      await expect(service.listArticleEvents(1)).resolves.toEqual([firstEvent]);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        description: "已基于 PostgreSQL 最新心跳解析 worker 状态",
        event: "operations.worker_status.resolved",
        lastHeartbeatAt: "2026-08-01T02:59:50.000Z",
        online: true,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("returns the D1-compatible empty overview when no snapshot or heartbeat exists", async () => {
    const database = scriptedPool(() => ({ rows: [] }));
    const service = createPostgresOperationsService({
      pool: database.pool,
      producer: { async sendBatch() {} },
      now: () => new Date("2026-08-01T03:00:00.000Z"),
    });

    await expect(service.getOverview()).resolves.toMatchObject({
      article_events: [],
      channels: { destinations: {}, sources: {} },
      generated_at: "2026-08-01T03:00:00.000Z",
      scheduler: { enabled: false, interval_seconds: 3_600, next_run_at: null },
      server: { online: true },
      status: "ok",
      sync_jobs: [],
      worker: { last_heartbeat_at: null, online: false },
    });
  });
});

function makeSyncJob(id: string, startedAt = "2026-08-01T02:00:00.000Z"): SyncJob {
  return {
    error: null,
    finished_at: null,
    id,
    started_at: startedAt,
    stats: {},
    status: "running",
    triggered_by: "manual",
  };
}

function makeArticleEvent(id: number) {
  return {
    filename: null,
    id,
    occurred_at: `2026-08-01T02:00:0${id}.000Z`,
    reason: null,
    source_url: `https://example.test/${id}`,
    status: "archived",
    title: `Article ${id}`,
    url_fingerprint: `fingerprint-${id}`,
  };
}

function withEnabledTelegram(value: OperationsOverview): OperationsOverview {
  return {
    ...value,
    channels: { ...value.channels, sources: { telegram: { enabled: true } } },
  };
}

function scriptedPool(
  respond: (sql: string, values: readonly unknown[]) => { rows: readonly Record<string, unknown>[] },
) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const events: string[] = [];
  let released = 0;
  return {
    calls,
    events,
    get released() {
      return released;
    },
    pool: {
      async connect() {
        return {
          async query<Row extends Record<string, unknown>>(
            sql: string,
            values: unknown[] = [],
          ): Promise<{ rows: readonly Row[] }> {
            calls.push({ sql, values });
            events.push(sql.trim());
            return respond(sql, values) as { rows: readonly Row[] };
          },
          release() {
            released += 1;
          },
        };
      },
    },
  };
}
