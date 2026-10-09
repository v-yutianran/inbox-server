import type {
  QueueReadinessSummary,
  RetentionReport,
} from "./operations-readiness.js";
import { evaluateThreshold } from "./operations-readiness.js";
import type { PostgresPool } from "./queue-inbox-postgres.js";

type AlertState = "pending" | "firing" | "recovered";
type Metric = { readonly key: string; readonly sampleCount: number; readonly value: number };
type Heartbeat = Record<string, unknown> & {
  readonly details: string;
  readonly last_seen_at: string;
};
type Alert = Record<string, unknown> & {
  readonly last_evaluated_at: string;
  readonly policy_key: string;
  readonly state: AlertState;
};

interface ReadinessReads {
  getQueueSummary(): Promise<QueueReadinessSummary>;
  getRetentionReport(input: { readonly retentionDays: number }): Promise<RetentionReport>;
}

export function createPostgresOperationsReadinessCapture(options: {
  readonly deploymentVersion?: string;
  readonly now?: () => Date;
  readonly pool: PostgresPool;
  readonly readiness: ReadinessReads;
}) {
  const deploymentVersion = options.deploymentVersion ?? "unknown";
  const now = options.now ?? (() => new Date());

  return {
    async captureMetrics(): Promise<void> {
      const current = now();
      const windowEnd = current.toISOString();
      const [queue, heartbeat] = await Promise.all([
        options.readiness.getQueueSummary(),
        withClient(options.pool, async (client) => {
          const result = await client.query<Heartbeat>(
            `SELECT details, last_seen_at FROM inbox_server.worker_heartbeats
             ORDER BY last_seen_at DESC LIMIT 1`,
          );
          return result.rows[0] ?? null;
        }),
      ]);
      const retentionReports = await Promise.all([7, 30, 90].map((retentionDays) =>
        options.readiness.getRetentionReport({ retentionDays })
      ));
      const details = parseJsonRecord(heartbeat?.details);
      const components = parseJsonRecord(details.components);
      const runtimeMetrics = parseJsonRecord(details.metrics);
      const articleExtraction = parseJsonRecord(runtimeMetrics.articleExtraction);
      const jobResults = parseJsonRecord(runtimeMetrics.jobResults);
      const heartbeatAt = heartbeat?.last_seen_at ?? null;
      const metrics: Metric[] = [
        { key: "api.availability", sampleCount: 1, value: 1 },
        {
          key: "worker.heartbeat_age_seconds",
          sampleCount: heartbeat ? 1 : 0,
          value: heartbeatAt
            ? Math.max(0, Math.floor((current.getTime() - Date.parse(heartbeatAt)) / 1_000))
            : 86_400,
        },
        { key: "queue.executable", sampleCount: 1, value: queue.categories.executable },
        { key: "queue.deferred", sampleCount: 1, value: queue.categories.deferred },
        {
          key: "queue.oldest_executable_age_seconds",
          sampleCount: queue.oldestExecutableAgeSeconds === null ? 0 : 1,
          value: queue.oldestExecutableAgeSeconds ?? 0,
        },
        {
          key: "worker.backlog",
          sampleCount: typeof details.backlogCount === "number" ? 1 : 0,
          value: typeof details.backlogCount === "number" ? details.backlogCount : 0,
        },
        ...(["browser", "mihomo", "warp"] as const).map((component) => ({
          key: `dependency.${component}.ready`,
          sampleCount: 1,
          value: parseJsonRecord(components[component]).state === "ready" ? 1 : 0,
        })),
        ...Object.entries(queue.jobStatusCounts).map(([status, value]) => ({
          key: `job.result.${status}`,
          sampleCount: 1,
          value,
        })),
        ...metricCounters("article.extraction", articleExtraction, {
          browserSucceeded: "browser_succeeded",
          directRejected: "direct_rejected",
          directSucceeded: "direct_succeeded",
          failed: "failed",
        }),
        ...metricCounters("worker.job", jobResults, {
          deadLettered: "dead_lettered",
          deferred: "deferred",
          retryableFailed: "retryable_failed",
          succeeded: "succeeded",
          uncertain: "uncertain",
        }),
      ];
      const dailySamples = retentionReports.flatMap((report) =>
        Object.entries(report.resources).map(([recordKind, resource]) => ({
          recordKind,
          report,
          resource,
        }))
      );
      const alertTransitions = await withTransaction(options.pool, async (client) => {
        const windowStart = new Date(current.getTime() - 10 * 60_000).toISOString();
        for (const metric of metrics) {
          await client.query(
            `INSERT INTO inbox_server.operations_metric_samples
             (metric_key, dimensions, window_start, window_end, value, sample_count,
              deployment_version, collected_at)
             VALUES ($1, '{}', $2, $3, $4, $5, $6, $3)
             ON CONFLICT(metric_key, dimensions, window_end) DO UPDATE SET
               value = EXCLUDED.value, sample_count = EXCLUDED.sample_count,
               deployment_version = EXCLUDED.deployment_version,
               collected_at = EXCLUDED.collected_at`,
            [metric.key, windowStart, windowEnd, metric.value, metric.sampleCount, deploymentVersion],
          );
        }
        const candidates = metrics.filter((metric) =>
          metric.sampleCount > 0 && candidateThreshold(metric.key) !== null
        );
        const previousByPolicy = new Map<string, Alert>();
        if (candidates.length > 0) {
          const keys = candidates.map(({ key }) => key).sort();
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext(policy_key))
             FROM unnest($1::text[]) AS candidate(policy_key)
             ORDER BY policy_key`,
            [keys],
          );
          const existing = await client.query<Alert>(
            `SELECT policy_key, state, last_evaluated_at
             FROM inbox_server.operations_alert_instances
             WHERE policy_key = ANY($1::text[]) FOR UPDATE`,
            [keys],
          );
          for (const row of existing.rows) previousByPolicy.set(row.policy_key, row);
        }
        const transitions: Array<{ readonly policyKey: string; readonly state: AlertState }> = [];
        for (const metric of candidates) {
          const threshold = candidateThreshold(metric.key)!;
          const previous = previousByPolicy.get(metric.key);
          if (previous?.last_evaluated_at === windowEnd) continue;
          const decision = evaluateThreshold({
            comparison: threshold.comparison,
            current: metric.value,
            previousState: previous?.state ?? null,
            threshold: threshold.value,
          });
          if (decision.state === null) {
            if (previous) {
              await client.query(
                "DELETE FROM inbox_server.operations_alert_instances WHERE policy_key = $1",
                [metric.key],
              );
            }
            continue;
          }
          await client.query(
            `INSERT INTO inbox_server.operations_alert_instances
             (policy_key, comparison, threshold_value, state, observed_value,
              first_observed_at, last_evaluated_at, last_transition_at, deployment_version)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)
             ON CONFLICT(policy_key) DO UPDATE SET
               comparison = EXCLUDED.comparison,
               threshold_value = EXCLUDED.threshold_value,
               state = EXCLUDED.state,
               observed_value = EXCLUDED.observed_value,
               first_observed_at = CASE
                 WHEN inbox_server.operations_alert_instances.state = 'recovered'
                      AND EXCLUDED.state = 'pending' THEN EXCLUDED.first_observed_at
                 ELSE inbox_server.operations_alert_instances.first_observed_at
               END,
               last_evaluated_at = EXCLUDED.last_evaluated_at,
               last_transition_at = CASE
                 WHEN inbox_server.operations_alert_instances.state <> EXCLUDED.state
                   THEN EXCLUDED.last_transition_at
                 ELSE inbox_server.operations_alert_instances.last_transition_at
               END,
               deployment_version = EXCLUDED.deployment_version`,
            [
              metric.key,
              threshold.comparison,
              threshold.value,
              decision.state,
              metric.value,
              windowEnd,
              deploymentVersion,
            ],
          );
          if (decision.transition === null) continue;
          const inserted = await client.query<Record<string, unknown>>(
            `INSERT INTO inbox_server.operations_alert_events
             (event_key, policy_key, state, comparison, threshold_value,
              observed_value, occurred_at, deployment_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(event_key) DO NOTHING
             RETURNING event_key`,
            [
              `${metric.key}:${decision.transition}:${windowEnd}`,
              metric.key,
              decision.transition,
              threshold.comparison,
              threshold.value,
              metric.value,
              windowEnd,
              deploymentVersion,
            ],
          );
          if (inserted.rows.length > 0) {
            transitions.push({ policyKey: metric.key, state: decision.transition });
          }
        }
        const sampleDate = windowEnd.slice(0, 10);
        for (const { recordKind, report, resource } of dailySamples) {
          await client.query(
            `INSERT INTO inbox_server.operations_retention_samples
             (sample_date, record_kind, window_days, cutoff_at, candidate_count,
              oldest_candidate_at, captured_at, deployment_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(sample_date, record_kind, window_days) DO UPDATE SET
               cutoff_at = EXCLUDED.cutoff_at,
               candidate_count = EXCLUDED.candidate_count,
               oldest_candidate_at = EXCLUDED.oldest_candidate_at,
               captured_at = EXCLUDED.captured_at,
               deployment_version = EXCLUDED.deployment_version`,
            [
              sampleDate,
              recordKind,
              report.retentionDays,
              report.cutoffAt,
              resource.candidates,
              resource.candidates > 0 ? resource.oldestAt : null,
              report.generatedAt,
              deploymentVersion,
            ],
          );
        }
        return transitions;
      });
      const metricSampleCutoff = new Date(current.getTime() - 7 * 24 * 60 * 60_000).toISOString();
      try {
        const pruned = await withClient(options.pool, (client) =>
          client.query<Record<string, unknown>>(
            `WITH expired AS (
               SELECT ctid FROM inbox_server.operations_metric_samples
               WHERE window_end < $1
               ORDER BY window_end ASC
               LIMIT $2
             ), deleted AS (
               DELETE FROM inbox_server.operations_metric_samples AS sample
               USING expired
               WHERE sample.ctid = expired.ctid
               RETURNING 1
             )
             SELECT count(*)::int AS deleted_count FROM deleted`,
            [metricSampleCutoff, 1_000],
          )
        );
        const deletedCount = Number(pruned.rows[0]?.deleted_count ?? 0);
        if (deletedCount > 0) {
          console.log(JSON.stringify({
            cutoffDate: metricSampleCutoff.slice(0, 10),
            deletedCount,
            description: "过期运维指标样本已分批清理",
            event: "operations.metrics.pruned",
            service: "api",
          }));
        }
      } catch {
        console.warn(JSON.stringify({
          cutoffDate: metricSampleCutoff.slice(0, 10),
          description: "运维指标样本清理失败，采集结果已保存",
          event: "operations.metrics.prune_failed",
          service: "api",
        }));
      }

      console.log(JSON.stringify({
        description: "生产运维低基数指标已聚合",
        event: "operations.metrics.captured",
        metricCount: metrics.length,
        windowEnd,
      }));
      for (const transition of alertTransitions) {
        console.log(JSON.stringify({
          description: "候选告警状态已进入脱敏审计，未发送外部通知",
          event: `operations.alert_candidate.${transition.state}`,
          policyKey: transition.policyKey,
          service: "api",
          state: transition.state,
        }));
      }
      console.log(JSON.stringify({
        description: "候选保留窗口每日聚合样本已幂等保存",
        event: "operations.retention.sampled",
        sampleCount: dailySamples.length,
        sampleDate: windowEnd.slice(0, 10),
        service: "api",
      }));
    },
  };
}

function candidateThreshold(key: string): {
  readonly comparison: "gt" | "lt";
  readonly value: number;
} | null {
  const thresholds: Readonly<Record<string, { comparison: "gt" | "lt"; value: number }>> = {
    "queue.executable": { comparison: "gt", value: 100 },
    "queue.oldest_executable_age_seconds": { comparison: "gt", value: 600 },
    "worker.heartbeat_age_seconds": { comparison: "gt", value: 90 },
    "dependency.browser.ready": { comparison: "lt", value: 1 },
    "dependency.mihomo.ready": { comparison: "lt", value: 1 },
    "dependency.warp.ready": { comparison: "lt", value: 1 },
  };
  return thresholds[key] ?? null;
}

function metricCounters(
  prefix: string,
  source: Readonly<Record<string, unknown>>,
  names: Readonly<Record<string, string>>,
): Metric[] {
  return Object.entries(names).map(([sourceKey, metricName]) => {
    const value = source[sourceKey];
    return {
      key: `${prefix}.${metricName}`,
      sampleCount: typeof value === "number" ? 1 : 0,
      value: typeof value === "number" ? value : 0,
    };
  });
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
  let transactionStarted = false;
  let failure: unknown;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await operation(client);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    failure = error;
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure; release closes the connection.
      }
    }
    throw error;
  } finally {
    await client.release(failure instanceof Error ? failure : undefined);
  }
}
