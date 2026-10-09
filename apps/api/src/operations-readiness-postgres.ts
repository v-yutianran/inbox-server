import type {
  DlqConsistencyReport,
  HealthComponentsReport,
  OperationsMetricsReport,
  QueueReadinessSummary,
  ReplayPlan,
  RetentionReport,
} from "./operations-readiness.js";
import type { ReplayResult } from "./control-plane.js";
import type { PostgresPool } from "./queue-inbox-postgres.js";
import {
  readLatestWorkerHeartbeat,
  type WorkerHeartbeatCache,
} from "./heartbeat-cache.js";

type ConsistencyCategory = keyof DlqConsistencyReport["counts"];

const consistencyCategories: readonly ConsistencyCategory[] = [
  "matched",
  "historical_migration",
  "orphan_dlq",
  "dead_without_dlq",
  "already_replayed",
  "missing_envelope",
  "integrity_anomaly",
];

interface QueueSummaryRow extends Record<string, unknown> {
  readonly deferred: number | string;
  readonly earliest_deferred_at: string | null;
  readonly executable: number | string;
  readonly job_status_counts: Record<string, number | string>;
  readonly oldest_executable_at: string | null;
  readonly processing: number | string;
}

interface DeadLetterRow extends Record<string, unknown> {
  readonly envelope_job_id: string | null;
  readonly envelope_payload_digest: string | null;
  readonly envelope_record_job_id: string | null;
  readonly envelope_status: string | null;
  readonly job_id: string;
  readonly job_status: string | null;
  readonly payload_digest: string;
  readonly replayed: boolean;
}

interface DeadJobRow extends Record<string, unknown> {
  readonly job_id: string;
}

interface ReplayStateRow extends Record<string, unknown> {
  readonly dead_letter_created_at: string | null;
  readonly effect_updated_at: string | null;
  readonly envelope_job_id: string | null;
  readonly envelope_status: string | null;
  readonly envelope_updated_at: string | null;
  readonly job_status: string;
  readonly job_updated_at: string;
  readonly replay_updated_at: string | null;
}

interface HeartbeatRow extends Record<string, unknown> {
  readonly details: string;
  readonly last_seen_at: string;
}

interface MetricRow extends Record<string, unknown> {
  readonly metric_key: string;
  readonly value: number | string;
  readonly window_end: string;
}

interface RetentionRow extends Record<string, unknown> {
  readonly candidates: number | string | null;
  readonly latest_at: string | null;
  readonly oldest_at: string | null;
  readonly total: number | string;
}

const retentionDefinitions = [
  { key: "heartbeats", table: "worker_heartbeats", column: "last_seen_at", risk: "心跳可重建，但影响在线历史趋势" },
  { key: "completedJobs", table: "worker_jobs", column: "finished_at", risk: "任务终态影响对账与重试审计", filter: "status = 'done'" },
  { key: "envelopes", table: "worker_job_envelopes", column: "updated_at", risk: "信封决定死信可恢复性" },
  { key: "deadLetters", table: "worker_dead_letters", column: "created_at", risk: "死信属于故障审计证据" },
  { key: "replayAudit", table: "worker_replay_operations", column: "updated_at", risk: "重放记录保护运维幂等" },
  { key: "effects", table: "worker_effects", column: "updated_at", risk: "effect 记录保护外部副作用幂等" },
] as const;

export function createPostgresOperationsReadinessService(options: {
  readonly deploymentVersion?: string;
  readonly heartbeatCache?: WorkerHeartbeatCache | undefined;
  readonly now?: () => Date;
  readonly pool: PostgresPool;
}) {
  const deploymentVersion = options.deploymentVersion ?? "unknown";
  const now = options.now ?? (() => new Date());

  return {
    async createReplayPlan(input: {
      readonly idempotencyKey: string;
      readonly jobId: string;
      readonly validation: ReplayResult;
    }): Promise<ReplayPlan> {
      const state = await withClient(options.pool, async (client) => {
        const result = await client.query<ReplayStateRow>(
          `SELECT j.status AS job_status, j.updated_at AS job_updated_at,
                  d.created_at AS dead_letter_created_at,
                  d.envelope_job_id AS envelope_job_id,
                  e.status AS envelope_status, e.updated_at AS envelope_updated_at,
                  (SELECT MAX(updated_at) FROM inbox_server.worker_effects
                   WHERE job_id = $1) AS effect_updated_at,
                  (SELECT MAX(updated_at) FROM inbox_server.worker_replay_operations
                   WHERE job_id = $1) AS replay_updated_at
           FROM inbox_server.worker_jobs j
           LEFT JOIN inbox_server.worker_dead_letters d ON d.job_id = j.job_id
           LEFT JOIN inbox_server.worker_job_envelopes e ON e.job_id = d.envelope_job_id
           WHERE j.job_id = $1`,
          [input.jobId],
        );
        return result.rows[0] ?? null;
      });
      const canonical = JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        jobId: input.jobId,
        state,
        validation: {
          published: input.validation.published,
          reason: input.validation.reason,
          replayable: input.validation.replayable,
          status: input.validation.status,
        },
      });
      return {
        ...input.validation,
        idempotencyKey: input.idempotencyKey,
        jobId: input.jobId,
        planHash: await sha256Hex(canonical),
      };
    },

    async getQueueSummary(): Promise<QueueReadinessSummary> {
      const current = now();
      const freezeAt = current.toISOString();
      return withClient(options.pool, async (client) => {
        const result = await client.query<QueueSummaryRow>(
          `SELECT
             (SELECT COUNT(*) FROM inbox_server.worker_inbox WHERE status = 'leased') AS processing,
             (SELECT COUNT(*) FROM inbox_server.worker_inbox
              WHERE status = 'queued' AND available_at <= $1) AS executable,
             (SELECT COUNT(*) FROM inbox_server.worker_inbox
              WHERE status = 'queued' AND available_at > $1) AS deferred,
             (SELECT MIN(created_at) FROM inbox_server.worker_inbox
              WHERE status = 'queued' AND available_at <= $1) AS oldest_executable_at,
             (SELECT MIN(available_at) FROM inbox_server.worker_inbox
              WHERE status = 'queued' AND available_at > $1) AS earliest_deferred_at,
             (SELECT COALESCE(jsonb_object_agg(status, job_count), '{}'::jsonb)
              FROM (
                SELECT status, COUNT(*) AS job_count
                FROM inbox_server.worker_jobs GROUP BY status
              ) AS job_counts) AS job_status_counts`,
          [freezeAt],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("PostgreSQL queue summary returned no row");
        const jobs = Object.fromEntries(
          Object.entries(row.job_status_counts).map(([status, count]) => [status, Number(count)]),
        );
        const oldestAt = row.oldest_executable_at;

        return {
          categories: {
            deferred: Number(row.deferred),
            executable: Number(row.executable),
            nonExecutable: (jobs.dead ?? 0) + (jobs.uncertain ?? 0),
            processing: Number(row.processing),
          },
          deploymentVersion,
          earliestDeferredAt: row.earliest_deferred_at,
          freezeAt,
          jobStatusCounts: jobs,
          oldestExecutableAgeSeconds:
            oldestAt === null
              ? null
              : Math.max(0, Math.floor((current.getTime() - Date.parse(oldestAt)) / 1_000)),
        };
      });
    },

    async getDlqConsistency(): Promise<DlqConsistencyReport> {
      const freezeAt = now().toISOString();
      return withClient(options.pool, async (client) => {
        const [deadLetters, deadWithoutDlq] = await Promise.all([
          client.query<DeadLetterRow>(
            `SELECT d.envelope_job_id, d.job_id, d.payload_digest,
                    j.status AS job_status,
                    e.job_id AS envelope_record_job_id,
                    e.payload_digest AS envelope_payload_digest,
                    e.status AS envelope_status,
                    EXISTS (
                      SELECT 1 FROM inbox_server.worker_replay_operations r
                      WHERE r.job_id = d.job_id AND r.status = 'published'
                    ) AS replayed
             FROM inbox_server.worker_dead_letters d
             LEFT JOIN inbox_server.worker_jobs j ON j.job_id = d.job_id
             LEFT JOIN inbox_server.worker_job_envelopes e ON e.job_id = d.envelope_job_id
             WHERE d.created_at <= $1
             ORDER BY d.job_id`,
            [freezeAt],
          ),
          client.query<DeadJobRow>(
            `SELECT j.job_id FROM inbox_server.worker_jobs j
             WHERE j.status = 'dead'
               AND NOT EXISTS (
                 SELECT 1 FROM inbox_server.worker_dead_letters d
                 WHERE d.job_id = j.job_id AND d.created_at <= $1
               )
             ORDER BY j.job_id`,
            [freezeAt],
          ),
        ]);
        const counts = emptyCounts();
        const samples = emptySamples();
        let deadJobs = deadWithoutDlq.rows.length;

        for (const row of deadLetters.rows) {
          const category = classifyDeadLetter(row);
          counts[category] += 1;
          samples[category].push(row.job_id);
          if (row.job_status === "dead") deadJobs += 1;
        }
        counts.dead_without_dlq = deadWithoutDlq.rows.length;
        samples.dead_without_dlq = deadWithoutDlq.rows.map(({ job_id }) => job_id);
        for (const category of consistencyCategories) samples[category].sort().splice(20);

        return {
          counts,
          deploymentVersion,
          freezeAt,
          samples,
          totals: { deadJobs, deadLetters: deadLetters.rows.length },
          unexplainedCount: 0,
        };
      });
    },

    async getHealthComponents(): Promise<HealthComponentsReport> {
      const current = now();
      const heartbeat = await readLatestWorkerHeartbeat({
        cache: options.heartbeatCache,
        now: current,
        pool: options.pool,
      });
      const details = parseJsonRecord(heartbeat?.details);
      const components = parseJsonRecord(details.components);
      const heartbeatAge = heartbeat
        ? current.getTime() - Date.parse(heartbeat.last_seen_at)
        : Number.POSITIVE_INFINITY;
      const workerReady = heartbeatAge >= -30_000 && heartbeatAge <= 90_000;
      const dependency = (component: "browser" | "mihomo" | "warp") => {
        const value = parseJsonRecord(components[component]);
        const state = isHealthState(value.state) ? value.state : "degraded";
        return {
          canAcceptWork: state === "ready",
          component,
          deploymentVersion,
          observedAt: typeof value.observedAt === "string"
            ? value.observedAt
            : heartbeat?.last_seen_at ?? current.toISOString(),
          reasonCode: typeof value.reasonCode === "string"
            ? value.reasonCode
            : "legacy_heartbeat_missing_component",
          state,
        } as const;
      };
      return {
        components: [
          {
            canAcceptWork: false,
            component: "console",
            deploymentVersion: "external",
            observedAt: current.toISOString(),
            reasonCode: "external_probe_required",
            state: "degraded",
          },
          {
            canAcceptWork: true,
            component: "api",
            deploymentVersion,
            observedAt: current.toISOString(),
            reasonCode: "request_succeeded",
            state: "ready",
          },
          {
            canAcceptWork: workerReady,
            component: "worker",
            deploymentVersion: typeof details.deploymentVersion === "string"
              ? details.deploymentVersion
              : "unknown",
            observedAt: heartbeat?.last_seen_at ?? current.toISOString(),
            reasonCode: workerReady ? "heartbeat_fresh" : "heartbeat_stale",
            state: workerReady ? "ready" : "degraded",
          },
          dependency("browser"),
          dependency("mihomo"),
          dependency("warp"),
        ],
        generatedAt: current.toISOString(),
      };
    },

    async getMetrics(input: { readonly windowHours: number }): Promise<OperationsMetricsReport> {
      const current = now();
      const cutoff = new Date(current.getTime() - input.windowHours * 60 * 60_000).toISOString();
      return withClient(options.pool, async (client) => {
        const result = await client.query<MetricRow>(
          `SELECT metric_key, value, window_end
           FROM inbox_server.operations_metric_samples
           WHERE window_end >= $1 ORDER BY metric_key, window_end`,
          [cutoff],
        );
        const grouped = new Map<string, Array<{ at: string; value: number }>>();
        for (const row of result.rows) {
          const trend = grouped.get(row.metric_key) ?? [];
          trend.push({ at: row.window_end, value: Number(row.value) });
          grouped.set(row.metric_key, trend);
        }
        return {
          deploymentVersion,
          generatedAt: current.toISOString(),
          metrics: [...grouped.entries()].map(([key, trend]) => ({
            current: trend.at(-1)?.value ?? 0,
            key,
            threshold: candidateThreshold(key),
            trend,
          })),
          windowHours: input.windowHours,
        };
      });
    },

    async getRetentionReport(input: { readonly retentionDays: number }): Promise<RetentionReport> {
      const current = now();
      const cutoffAt = new Date(
        current.getTime() - input.retentionDays * 24 * 60 * 60 * 1_000,
      ).toISOString();
      return withClient(options.pool, async (client) => {
        const reports = await Promise.all(retentionDefinitions.map(async (definition) => {
          const result = await client.query<RetentionRow>(
            `SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE ${definition.column} < $1) AS candidates,
                    MIN(${definition.column}) AS oldest_at,
                    MAX(${definition.column}) AS latest_at
             FROM inbox_server.${definition.table}
             ${"filter" in definition ? `WHERE ${definition.filter}` : ""}`,
            [cutoffAt],
          );
          const row = result.rows[0];
          return [definition.key, {
            candidates: Number(row?.candidates ?? 0),
            latestAt: row?.latest_at ?? null,
            oldestAt: row?.oldest_at ?? null,
            risk: definition.risk,
            total: Number(row?.total ?? 0),
          }] as const;
        }));
        return {
          cutoffAt,
          dryRun: true,
          generatedAt: current.toISOString(),
          resources: Object.fromEntries(reports),
          retentionDays: input.retentionDays,
        };
      });
    },
  };
}

function classifyDeadLetter(row: DeadLetterRow): ConsistencyCategory {
  if (row.job_status === null) return "orphan_dlq";
  if (row.replayed) return "already_replayed";
  if (row.job_status !== "dead") return "historical_migration";
  if (row.envelope_job_id === null || row.envelope_record_job_id === null) {
    return "missing_envelope";
  }
  if (
    row.envelope_record_job_id !== row.job_id ||
    row.envelope_status !== "dead" ||
    row.envelope_payload_digest !== row.payload_digest
  ) {
    return "integrity_anomaly";
  }
  return "matched";
}

function emptyCounts(): Record<ConsistencyCategory, number> {
  return consistencyCategories.reduce((counts, category) => {
    counts[category] = 0;
    return counts;
  }, {} as Record<ConsistencyCategory, number>);
}

function emptySamples(): Record<ConsistencyCategory, string[]> {
  return consistencyCategories.reduce((samples, category) => {
    samples[category] = [];
    return samples;
  }, {} as Record<ConsistencyCategory, string[]>);
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

function candidateThreshold(
  key: string,
): OperationsMetricsReport["metrics"][number]["threshold"] {
  const thresholds: Readonly<Record<string, { comparison: "gt" | "lt"; value: number }>> = {
    "queue.executable": { comparison: "gt", value: 100 },
    "queue.oldest_executable_age_seconds": { comparison: "gt", value: 600 },
    "worker.heartbeat_age_seconds": { comparison: "gt", value: 90 },
    "dependency.browser.ready": { comparison: "lt", value: 1 },
    "dependency.mihomo.ready": { comparison: "lt", value: 1 },
    "dependency.warp.ready": { comparison: "lt", value: 1 },
  };
  const threshold = thresholds[key];
  return threshold ? { ...threshold, state: "candidate" } : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isHealthState(value: unknown): value is "starting" | "ready" | "degraded" | "stopping" | "failed" {
  return ["starting", "ready", "degraded", "stopping", "failed"].includes(String(value));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
