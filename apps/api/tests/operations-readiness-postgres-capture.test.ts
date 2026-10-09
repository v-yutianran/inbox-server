import { afterEach, describe, expect, it, vi } from "vitest";

import { createPostgresOperationsReadinessCapture } from "../src/operations-readiness-postgres-capture.js";
import type { PostgresPool } from "../src/queue-inbox-postgres.js";
import type { QueueReadinessSummary, RetentionReport } from "../src/operations-readiness.js";

type Row = Record<string, unknown>;
type MetricRow = {
  readonly key: string;
  readonly windowEnd: string;
  readonly value: number;
  readonly sampleCount: number;
};
type AlertRow = {
  readonly policy_key: string;
  readonly state: "pending" | "firing" | "recovered";
  readonly last_evaluated_at: string;
  readonly first_observed_at: string;
  readonly last_transition_at: string;
};
type State = {
  metrics: Map<string, MetricRow>;
  alerts: Map<string, AlertRow>;
  events: Map<string, Row>;
  retention: Map<string, Row>;
};

afterEach(() => vi.restoreAllMocks());

describe("PostgreSQL operations readiness metric capture", () => {
  it("prunes at most one batch older than seven days and keeps the exact cutoff", async () => {
    const current = new Date("2030-01-10T12:00:00.000Z");
    const cutoff = "2030-01-03T12:00:00.000Z";
    const expired = Array.from({ length: 1_001 }, (_, index) => ({
      key: `expired.${index}`,
      windowEnd: new Date(Date.parse(cutoff) - 1_001 + index).toISOString(),
      value: index,
      sampleCount: 1,
    }));
    const seededMetrics = [
      ...expired,
      { key: "at-cutoff", windowEnd: cutoff, value: 1, sampleCount: 1 },
      { key: "inside-window", windowEnd: "2030-01-03T12:00:00.001Z", value: 1, sampleCount: 1 },
    ];
    const statements: Array<{ readonly sql: string; readonly values: unknown[] }> = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { pool, state } = memoryPool((sql, values) => statements.push({ sql, values }), seededMetrics);
    const capture = createCapture(pool, () => current);

    await capture.captureMetrics();

    const remainingExpired = [...state.metrics.values()].filter((metric) => metric.windowEnd < cutoff);
    expect(remainingExpired).toHaveLength(1);
    expect(state.metrics.has(`at-cutoff:${cutoff}`)).toBe(true);
    expect(state.metrics.has("inside-window:2030-01-03T12:00:00.001Z")).toBe(true);
    expect(statements.filter(({ sql }) => sql.includes("DELETE FROM inbox_server.operations_metric_samples"))).toEqual([
      expect.objectContaining({
        sql: expect.stringMatching(/window_end\s*<\s*\$1[\s\S]*ORDER BY window_end ASC[\s\S]*LIMIT \$2/),
        values: [cutoff, 1_000],
      }),
    ]);
    const pruneLog = log.mock.calls
      .map(([message]) => JSON.parse(message as string) as Record<string, unknown>)
      .find(({ event }) => event === "operations.metrics.pruned");
    expect(pruneLog).toMatchObject({ deletedCount: 1_000 });
  });

  it("writes metrics, alerts, and daily retention samples in one transaction", async () => {
    const { pool, state, queries } = memoryPool();
    const capture = createCapture(pool, () => new Date("2030-01-01T00:00:00.000Z"));

    await capture.captureMetrics();

    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");
    expect(queries.indexOf("COMMIT")).toBeLessThan(
      queries.findIndex((query) => query.includes("DELETE FROM inbox_server.operations_metric_samples")),
    );
    expect(state.metrics.size).toBeGreaterThan(0);
    expect([...state.retention.values()].map((row) => row.window_days).sort((left, right) => Number(left) - Number(right))).toEqual([7, 30, 90]);
    expect(state.alerts.get("queue.executable")?.state).toBe("pending");
  });

  it("is idempotent for a repeated observation window and UTC retention day", async () => {
    const { pool, state } = memoryPool();
    const capture = createCapture(pool, () => new Date("2030-01-01T00:00:00.000Z"));

    await capture.captureMetrics();
    expect(state.alerts.get("queue.executable")?.last_evaluated_at).toBe("2030-01-01T00:00:00.000Z");
    await capture.captureMetrics();

    expect(state.metrics.size).toBeGreaterThan(0);
    expect(state.events.size).toBe(2);
    expect([...state.events.values()].every((row) => row.state === "pending")).toBe(true);
    expect(state.retention.size).toBe(3);
  });

  it("keeps metric capture successful when a metric-prune batch fails", async () => {
    const { pool, state, queries } = memoryPool((sql) => {
      if (sql.includes("DELETE FROM inbox_server.operations_metric_samples")) {
        throw new Error("synthetic PostgreSQL prune failure");
      }
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const capture = createCapture(pool, () => new Date("2030-01-10T12:00:00.000Z"));

    await expect(capture.captureMetrics()).resolves.toBeUndefined();

    expect(queries).toContain("COMMIT");
    expect(queries.indexOf("COMMIT")).toBeLessThan(
      queries.findIndex((query) => query.includes("DELETE FROM inbox_server.operations_metric_samples")),
    );
    expect(state.metrics.size).toBeGreaterThan(0);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(warning.mock.calls[0]?.[0] as string)).toMatchObject({
      event: "operations.metrics.prune_failed",
      service: "api",
    });
  });

  it("records pending, firing, and recovered transitions", async () => {
    const { pool, state } = memoryPool();
    let current = new Date("2030-01-01T00:00:00.000Z");
    let executable = 101;
    const capture = createCapture(pool, () => current, () => executable);

    await capture.captureMetrics();
    current = new Date("2030-01-01T00:10:00.000Z");
    await capture.captureMetrics();
    current = new Date("2030-01-01T00:20:00.000Z");
    executable = 0;
    await capture.captureMetrics();

    expect([...state.events.values()]
      .filter((row) => row.policy_key === "queue.executable")
      .map((row) => row.state)).toEqual(["pending", "firing", "recovered"]);
    expect(state.alerts.get("queue.executable")?.state).toBe("recovered");
  });

  it("rolls all persistence back and emits no success logs on an injected write failure", async () => {
    const { pool, state, queries } = memoryPool((sql) => {
      if (sql.includes("INSERT INTO inbox_server.operations_retention_samples")) {
        throw new Error("synthetic PostgreSQL write failure");
      }
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const capture = createCapture(pool, () => new Date("2030-01-01T00:00:00.000Z"));

    await expect(capture.captureMetrics()).rejects.toThrow("synthetic PostgreSQL write failure");

    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(state.metrics.size).toBe(0);
    expect(state.alerts.size).toBe(0);
    expect(state.events.size).toBe(0);
    expect(state.retention.size).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });
});

function createCapture(
  pool: PostgresPool,
  now: () => Date,
  executable: () => number = () => 101,
) {
  const readiness = {
    async getQueueSummary(): Promise<QueueReadinessSummary> {
      const current = now();
      return {
        categories: { deferred: 0, executable: executable(), nonExecutable: 0, processing: 0 },
        deploymentVersion: "read-model-version",
        earliestDeferredAt: null,
        freezeAt: current.toISOString(),
        jobStatusCounts: { done: 1 },
        oldestExecutableAgeSeconds: executable() === 0 ? null : 650,
      };
    },
    async getRetentionReport({ retentionDays }: { readonly retentionDays: number }): Promise<RetentionReport> {
      const current = now();
      return {
        cutoffAt: current.toISOString(),
        dryRun: true,
        generatedAt: current.toISOString(),
        resources: {
          jobs: {
            candidates: retentionDays,
            latestAt: null,
            oldestAt: "2029-01-01T00:00:00.000Z",
            risk: "test",
            total: retentionDays,
          },
        },
        retentionDays,
      };
    },
  };
  return createPostgresOperationsReadinessCapture({
    deploymentVersion: "capture-version",
    now,
    pool,
    readiness,
  });
}

function memoryPool(
  onQuery: (sql: string, values: unknown[]) => void = () => undefined,
  initialMetrics: readonly MetricRow[] = [],
) {
  const state: State = {
    metrics: new Map(initialMetrics.map((metric) => [`${metric.key}:${metric.windowEnd}`, metric])),
    alerts: new Map(),
    events: new Map(),
    retention: new Map(),
  };
  const queries: string[] = [];
  let transaction: State | null = null;
  const clone = (): State => ({
    metrics: new Map(state.metrics),
    alerts: new Map(state.alerts),
    events: new Map(state.events),
    retention: new Map(state.retention),
  });
  const restore = (source: State) => {
    state.metrics = source.metrics;
    state.alerts = source.alerts;
    state.events = source.events;
    state.retention = source.retention;
  };
  const pool: PostgresPool = {
    async connect() {
      return {
        async query<Row extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
          const query = sql.trim();
          queries.push(query);
          onQuery(query, values);
          if (query === "BEGIN") transaction = clone();
          if (query === "ROLLBACK" && transaction) restore(transaction);
          if (query === "COMMIT") transaction = null;
          if (query.includes("SELECT details, last_seen_at")) {
            return { rows: [{ details: JSON.stringify({ components: {
              browser: { state: "ready" }, mihomo: { state: "ready" }, warp: { state: "ready" },
            } }), last_seen_at: "2030-01-01T00:00:00.000Z" }] as unknown as Row[] };
          }
          if (query.includes("SELECT policy_key, state, last_evaluated_at")) {
            const keys = values[0] as string[];
            return { rows: [...state.alerts.values()].filter((row) => keys.includes(row.policy_key)) as unknown as Row[] };
          }
          if (query.includes("INSERT INTO inbox_server.operations_metric_samples")) {
            const [key, , windowEnd, value, sampleCount] = values as [string, string, string, number, number];
            state.metrics.set(`${key}:${windowEnd}`, { key, windowEnd, value, sampleCount });
          }
          if (query.includes("DELETE FROM inbox_server.operations_metric_samples")) {
            const [cutoff, batchSize] = values as [string, number];
            const expired = [...state.metrics.entries()]
              .filter(([, metric]) => metric.windowEnd < cutoff)
              .sort(([, left], [, right]) => left.windowEnd.localeCompare(right.windowEnd))
              .slice(0, batchSize);
            for (const [key] of expired) state.metrics.delete(key);
            return { rows: [{ deleted_count: expired.length }] as unknown as Row[] };
          }
          if (query.includes("DELETE FROM inbox_server.operations_alert_instances")) {
            state.alerts.delete(String(values[0]));
          }
          if (query.includes("INSERT INTO inbox_server.operations_alert_instances")) {
            const [policyKey, , , alertState, , observedAt] = values as [string, string, number, AlertRow["state"], number, string, string];
            const previous = state.alerts.get(policyKey);
            state.alerts.set(policyKey, {
              policy_key: policyKey,
              state: alertState,
              first_observed_at: previous?.state === "recovered" && alertState === "pending"
                ? observedAt
                : previous?.first_observed_at ?? observedAt,
              last_evaluated_at: observedAt,
              last_transition_at: previous?.state !== alertState ? observedAt : previous.last_transition_at,
            });
          }
          if (query.includes("INSERT INTO inbox_server.operations_alert_events")) {
            const [eventKey, policyKey, eventState] = values as [string, string, string];
            const inserted = !state.events.has(eventKey);
            if (inserted) state.events.set(eventKey, { policy_key: policyKey, state: eventState });
            return { rows: inserted ? [{ event_key: eventKey }] as unknown as Row[] : [] };
          }
          if (query.includes("INSERT INTO inbox_server.operations_retention_samples")) {
            const [sampleDate, recordKind, windowDays, cutoffAt, candidateCount] = values as [string, string, number, string, number];
            state.retention.set(`${sampleDate}:${recordKind}:${windowDays}`, { window_days: windowDays, cutoffAt, candidateCount });
          }
          return { rows: [] as Row[] } as { rows: Row[] };
        },
        release() {},
      };
    },
  };
  return { pool, queries, state, clone };
}
