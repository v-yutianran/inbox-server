import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPostgresOperationsReadinessService } from "../src/operations-readiness-postgres";

describe("PostgreSQL operations readiness reads", () => {
  it("uses fresh cached heartbeat details for readiness without querying Neon", async () => {
    const database = scriptedPool(() => ({ rows: [] }));
    const heartbeatCache = {
      get: async () => ({
        details: JSON.stringify({ deploymentVersion: "cached-worker" }),
        last_seen_at: "2030-01-01T00:00:00.000Z",
        worker_id: "worker-cache",
      }),
      setIfNewer: async () => undefined,
    };
    const service = createPostgresOperationsReadinessService({
      deploymentVersion: "api-version",
      heartbeatCache,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      pool: database.pool,
    } as Parameters<typeof createPostgresOperationsReadinessService>[0]);

    await expect(service.getHealthComponents()).resolves.toMatchObject({
      components: expect.arrayContaining([
        { canAcceptWork: true, component: "worker", deploymentVersion: "cached-worker", observedAt: "2030-01-01T00:00:00.000Z", reasonCode: "heartbeat_fresh", state: "ready" },
      ]),
    });
    expect(database.calls.some(({ sql }) => sql.includes("FROM inbox_server.worker_heartbeats"))).toBe(false);
  });

  it("returns the D1 queue summary contract and category rules", async () => {
    const database = scriptedPool(() => ({
      rows: [{
        deferred: "2",
        earliest_deferred_at: "2030-01-01T00:05:00.000Z",
        executable: "3",
        job_status_counts: { dead: 5, done: 11, failed: 3, uncertain: 2 },
        oldest_executable_at: "2029-12-31T23:50:00.000Z",
        processing: "4",
      }],
    }));
    const service = createPostgresOperationsReadinessService({
      deploymentVersion: "test-version",
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      pool: database.pool,
    });

    await expect(service.getQueueSummary()).resolves.toEqual({
      categories: { deferred: 2, executable: 3, nonExecutable: 7, processing: 4 },
      deploymentVersion: "test-version",
      earliestDeferredAt: "2030-01-01T00:05:00.000Z",
      freezeAt: "2030-01-01T00:00:00.000Z",
      jobStatusCounts: { dead: 5, done: 11, failed: 3, uncertain: 2 },
      oldestExecutableAgeSeconds: 600,
    });
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_inbox");
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_jobs");
    expect(database.calls[0]?.values).toEqual(["2030-01-01T00:00:00.000Z"]);
    expect(database.released).toBe(1);
  });

  it("preserves all DLQ categories, precedence, sorted sample cap, and totals", async () => {
    const deadLetters = [
      dlqRow("orphan", null),
      dlqRow("replayed", "failed", { replayed: true }),
      dlqRow("historical", "done"),
      dlqRow("missing", "dead", { envelopeJobId: null }),
      dlqRow("anomaly", "dead", { envelopeDigest: "different" }),
      dlqRow("matched", "dead"),
      ...Array.from({ length: 22 }, (_, index) =>
        dlqRow(`matched-${String(index).padStart(2, "0")}`, "dead"),
      ).reverse(),
    ];
    const database = scriptedPool((sql) => ({
      rows: sql.includes("SELECT d.envelope_job_id")
        ? deadLetters
        : [{ job_id: "dead-only" }],
    }));
    const service = createPostgresOperationsReadinessService({
      deploymentVersion: "test-version",
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      pool: database.pool,
    });

    await expect(service.getDlqConsistency()).resolves.toEqual({
      counts: {
        already_replayed: 1,
        dead_without_dlq: 1,
        historical_migration: 1,
        integrity_anomaly: 1,
        matched: 23,
        missing_envelope: 1,
        orphan_dlq: 1,
      },
      deploymentVersion: "test-version",
      freezeAt: "2030-01-01T00:00:00.000Z",
      samples: {
        already_replayed: ["replayed"],
        dead_without_dlq: ["dead-only"],
        historical_migration: ["historical"],
        integrity_anomaly: ["anomaly"],
        matched: ["matched", ...Array.from({ length: 19 }, (_, index) => `matched-${String(index).padStart(2, "0")}`)],
        missing_envelope: ["missing"],
        orphan_dlq: ["orphan"],
      },
      totals: { deadJobs: 26, deadLetters: 28 },
      unexplainedCount: 0,
    });
    expect(database.calls).toHaveLength(2);
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_dead_letters");
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_job_envelopes");
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_replay_operations");
    expect(database.calls[0]?.values).toEqual(["2030-01-01T00:00:00.000Z"]);
    expect(database.calls[1]?.sql).toContain("inbox_server.worker_jobs");
    expect(database.calls[1]?.sql).toContain("d.created_at <= $1");
    expect(database.calls[1]?.values).toEqual(["2030-01-01T00:00:00.000Z"]);
    expect(database.released).toBe(1);
  });

  it("releases the connection when a query fails", async () => {
    const failure = new Error("synthetic PostgreSQL failure");
    const database = scriptedPool(() => {
      throw failure;
    });
    const service = createPostgresOperationsReadinessService({ pool: database.pool });

    await expect(service.getQueueSummary()).rejects.toBe(failure);
    expect(database.released).toBe(1);
  });

  it("builds the same replay plan hash from the PostgreSQL state snapshot", async () => {
    const state = {
      dead_letter_created_at: "2030-01-01T00:00:00.000Z",
      effect_updated_at: "2030-01-01T00:01:00.000Z",
      envelope_job_id: "job-1",
      envelope_status: "dead",
      envelope_updated_at: "2030-01-01T00:02:00.000Z",
      job_status: "dead",
      job_updated_at: "2030-01-01T00:03:00.000Z",
      replay_updated_at: null,
    };
    const validation = {
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated" as const,
    };
    const database = scriptedPool(() => ({ rows: [state] }));
    const service = createPostgresOperationsReadinessService({ pool: database.pool });
    const canonical = JSON.stringify({
      idempotencyKey: "operation-1",
      jobId: "job-1",
      state,
      validation,
    });

    await expect(service.createReplayPlan({
      idempotencyKey: "operation-1",
      jobId: "job-1",
      validation,
    })).resolves.toEqual({
      ...validation,
      idempotencyKey: "operation-1",
      jobId: "job-1",
      planHash: createHash("sha256").update(canonical).digest("hex"),
    });
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_jobs");
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_effects");
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_replay_operations");
    expect(database.calls[0]?.values).toEqual(["job-1"]);
    expect(database.released).toBe(1);
  });

  it("maps worker heartbeat and component health using the D1 freshness window", async () => {
    const database = scriptedPool(() => ({
      rows: [{
        details: JSON.stringify({
          components: {
            browser: {
              observedAt: "2030-01-01T00:00:20.000Z",
              reasonCode: "browser_ok",
              state: "ready",
            },
            mihomo: { state: "starting" },
            warp: { state: "not-a-health-state" },
          },
          deploymentVersion: "worker-version",
        }),
        last_seen_at: "2030-01-01T00:00:30.000Z",
      }],
    }));
    const service = createPostgresOperationsReadinessService({
      deploymentVersion: "api-version",
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      pool: database.pool,
    });

    await expect(service.getHealthComponents()).resolves.toEqual({
      components: [
        { canAcceptWork: false, component: "console", deploymentVersion: "external", observedAt: "2030-01-01T00:00:00.000Z", reasonCode: "external_probe_required", state: "degraded" },
        { canAcceptWork: true, component: "api", deploymentVersion: "api-version", observedAt: "2030-01-01T00:00:00.000Z", reasonCode: "request_succeeded", state: "ready" },
        { canAcceptWork: true, component: "worker", deploymentVersion: "worker-version", observedAt: "2030-01-01T00:00:30.000Z", reasonCode: "heartbeat_fresh", state: "ready" },
        { canAcceptWork: true, component: "browser", deploymentVersion: "api-version", observedAt: "2030-01-01T00:00:20.000Z", reasonCode: "browser_ok", state: "ready" },
        { canAcceptWork: false, component: "mihomo", deploymentVersion: "api-version", observedAt: "2030-01-01T00:00:30.000Z", reasonCode: "legacy_heartbeat_missing_component", state: "starting" },
        { canAcceptWork: false, component: "warp", deploymentVersion: "api-version", observedAt: "2030-01-01T00:00:30.000Z", reasonCode: "legacy_heartbeat_missing_component", state: "degraded" },
      ],
      generatedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(database.calls[0]?.sql).toContain("inbox_server.worker_heartbeats");
    expect(database.released).toBe(1);
  });

  it("groups metric trends, applies the same candidate thresholds, and binds the cutoff", async () => {
    const database = scriptedPool(() => ({
      rows: [
        { metric_key: "queue.executable", value: "3", window_end: "2029-12-31T20:00:00.000Z" },
        { metric_key: "queue.executable", value: "101", window_end: "2029-12-31T23:00:00.000Z" },
        { metric_key: "custom.metric", value: "4.5", window_end: "2029-12-31T23:30:00.000Z" },
      ],
    }));
    const service = createPostgresOperationsReadinessService({
      deploymentVersion: "api-version",
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      pool: database.pool,
    });

    await expect(service.getMetrics({ windowHours: 6 })).resolves.toEqual({
      deploymentVersion: "api-version",
      generatedAt: "2030-01-01T00:00:00.000Z",
      metrics: [
        {
          current: 101,
          key: "queue.executable",
          threshold: { comparison: "gt", state: "candidate", value: 100 },
          trend: [
            { at: "2029-12-31T20:00:00.000Z", value: 3 },
            { at: "2029-12-31T23:00:00.000Z", value: 101 },
          ],
        },
        {
          current: 4.5,
          key: "custom.metric",
          threshold: null,
          trend: [{ at: "2029-12-31T23:30:00.000Z", value: 4.5 }],
        },
      ],
      windowHours: 6,
    });
    expect(database.calls[0]?.sql).toContain("inbox_server.operations_metric_samples");
    expect(database.calls[0]?.sql).toContain("ORDER BY metric_key, window_end");
    expect(database.calls[0]?.values).toEqual(["2029-12-31T18:00:00.000Z"]);
    expect(database.released).toBe(1);
  });

  it("reports retention candidates for only the fixed PostgreSQL tables", async () => {
    const database = scriptedPool((sql) => {
      const table = sql.match(/FROM inbox_server\.(\w+)/)?.[1];
      return {
        rows: table === "worker_heartbeats"
          ? [{ candidates: "2", latest_at: "2029-12-31T00:00:00.000Z", oldest_at: "2029-01-01T00:00:00.000Z", total: "4" }]
          : [{ candidates: "0", latest_at: null, oldest_at: null, total: "0" }],
      };
    });
    const service = createPostgresOperationsReadinessService({
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      pool: database.pool,
    });

    const report = await service.getRetentionReport({ retentionDays: 30 });

    expect(report).toEqual({
      cutoffAt: "2029-12-02T00:00:00.000Z",
      dryRun: true,
      generatedAt: "2030-01-01T00:00:00.000Z",
      retentionDays: 30,
      resources: {
        heartbeats: { candidates: 2, latestAt: "2029-12-31T00:00:00.000Z", oldestAt: "2029-01-01T00:00:00.000Z", risk: "心跳可重建，但影响在线历史趋势", total: 4 },
        completedJobs: { candidates: 0, latestAt: null, oldestAt: null, risk: "任务终态影响对账与重试审计", total: 0 },
        envelopes: { candidates: 0, latestAt: null, oldestAt: null, risk: "信封决定死信可恢复性", total: 0 },
        deadLetters: { candidates: 0, latestAt: null, oldestAt: null, risk: "死信属于故障审计证据", total: 0 },
        replayAudit: { candidates: 0, latestAt: null, oldestAt: null, risk: "重放记录保护运维幂等", total: 0 },
        effects: { candidates: 0, latestAt: null, oldestAt: null, risk: "effect 记录保护外部副作用幂等", total: 0 },
      },
    });
    expect(database.calls).toHaveLength(6);
    expect(database.calls.every(({ values }) => values[0] === "2029-12-02T00:00:00.000Z")).toBe(true);
    expect(database.calls.find(({ sql }) => sql.includes("worker_jobs"))?.sql)
      .toContain("status = 'done'");
    expect(database.calls.every(({ sql }) => /FROM inbox_server\.(worker_heartbeats|worker_jobs|worker_job_envelopes|worker_dead_letters|worker_replay_operations|worker_effects)/.test(sql))).toBe(true);
    expect(database.released).toBe(1);
  });
});

function dlqRow(
  jobId: string,
  jobStatus: string | null,
  options: { envelopeDigest?: string; envelopeJobId?: string | null; replayed?: boolean } = {},
) {
  const hasEnvelope = options.envelopeJobId !== null;
  return {
    envelope_job_id: hasEnvelope ? options.envelopeJobId ?? jobId : null,
    envelope_payload_digest: options.envelopeDigest ?? `digest-${jobId}`,
    envelope_record_job_id: hasEnvelope ? jobId : null,
    envelope_status: hasEnvelope ? "dead" : null,
    job_id: jobId,
    job_status: jobStatus,
    payload_digest: `digest-${jobId}`,
    replayed: options.replayed ?? false,
  };
}

function scriptedPool(
  respond: (sql: string, values: readonly unknown[]) => { rows: readonly Record<string, unknown>[] },
) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let released = 0;
  return {
    calls,
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
