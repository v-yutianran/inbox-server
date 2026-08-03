import type { ApiBindings } from "./auth.js";
import type { ReplayResult } from "./control-plane.js";

const CONSISTENCY_CATEGORIES = [
  "matched",
  "historical_migration",
  "orphan_dlq",
  "dead_without_dlq",
  "already_replayed",
  "missing_envelope",
  "integrity_anomaly",
] as const;

type ConsistencyCategory = (typeof CONSISTENCY_CATEGORIES)[number];
type CountRow = { readonly count: number | string; readonly status: string };
type TimeSummaryRow = {
  readonly candidates: number | string | null;
  readonly latest_at: string | null;
  readonly oldest_at: string | null;
  readonly total: number | string;
};
type CandidateAlertState = "pending" | "firing" | "recovered";
type CandidateMetric = { readonly key: string; readonly sampleCount: number; readonly value: number };
type AlertInstanceRow = {
  readonly last_evaluated_at: string;
  readonly policy_key: string;
  readonly state: CandidateAlertState;
};

export interface QueueReadinessSummary {
  readonly categories: {
    readonly deferred: number;
    readonly executable: number;
    readonly nonExecutable: number;
    readonly processing: number;
  };
  readonly deploymentVersion: string;
  readonly earliestDeferredAt: string | null;
  readonly freezeAt: string;
  readonly jobStatusCounts: Readonly<Record<string, number>>;
  readonly oldestExecutableAgeSeconds: number | null;
}

export interface DlqConsistencyReport {
  readonly counts: Readonly<Record<ConsistencyCategory, number>>;
  readonly deploymentVersion: string;
  readonly freezeAt: string;
  readonly samples: Readonly<Record<ConsistencyCategory, readonly string[]>>;
  readonly totals: { readonly deadJobs: number; readonly deadLetters: number };
  readonly unexplainedCount: 0;
}

export interface RetentionResourceReport {
  readonly candidates: number;
  readonly latestAt: string | null;
  readonly oldestAt: string | null;
  readonly risk: string;
  readonly total: number;
}

export interface RetentionReport {
  readonly cutoffAt: string;
  readonly dryRun: true;
  readonly generatedAt: string;
  readonly resources: Readonly<Record<string, RetentionResourceReport>>;
  readonly retentionDays: number;
}

export interface ReplayPlan extends ReplayResult {
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly planHash: string;
}

export type HealthComponentName = "console" | "api" | "worker" | "browser" | "mihomo" | "warp";
export type HealthComponentState = "starting" | "ready" | "degraded" | "stopping" | "failed";

export interface HealthComponentsReport {
  readonly components: readonly {
    readonly canAcceptWork: boolean;
    readonly component: HealthComponentName;
    readonly deploymentVersion: string;
    readonly observedAt: string;
    readonly reasonCode: string;
    readonly state: HealthComponentState;
  }[];
  readonly generatedAt: string;
}

export interface OperationsMetricsReport {
  readonly deploymentVersion: string;
  readonly generatedAt: string;
  readonly metrics: readonly {
    readonly current: number;
    readonly key: string;
    readonly threshold: {
      readonly comparison: "gt" | "lt";
      readonly state: "candidate";
      readonly value: number;
    } | null;
    readonly trend: readonly { readonly at: string; readonly value: number }[];
  }[];
  readonly windowHours: number;
}

export interface OperationsReadinessService {
  captureMetrics(): Promise<void>;
  createReplayPlan(input: {
    readonly idempotencyKey: string;
    readonly jobId: string;
    readonly validation: ReplayResult;
  }): Promise<ReplayPlan>;
  getDlqConsistency(): Promise<DlqConsistencyReport>;
  getHealthComponents(): Promise<HealthComponentsReport>;
  getMetrics(input: { readonly windowHours: number }): Promise<OperationsMetricsReport>;
  getQueueSummary(): Promise<QueueReadinessSummary>;
  getRetentionReport(input: { readonly retentionDays: number }): Promise<RetentionReport>;
}

interface ServiceOptions {
  readonly database: D1Database;
  readonly deploymentVersion?: string;
  readonly now?: () => Date;
}

export function createOperationsReadinessServiceFromBindings(
  bindings: ApiBindings,
): OperationsReadinessService {
  return createD1OperationsReadinessService({
    database: bindings.DB,
    ...(bindings.CF_VERSION_METADATA?.id || bindings.DEPLOYMENT_VERSION
      ? {
          deploymentVersion:
            bindings.CF_VERSION_METADATA?.id ?? bindings.DEPLOYMENT_VERSION!,
        }
      : {}),
  });
}

export function createD1OperationsReadinessService({
  database,
  deploymentVersion = "unknown",
  now = () => new Date(),
}: ServiceOptions): OperationsReadinessService {
  const service: OperationsReadinessService = {
    async captureMetrics() {
      const current = now();
      const [queue, heartbeat] = await Promise.all([
        service.getQueueSummary(),
        latestHeartbeat(database),
      ]);
      const details = parseJsonRecord(heartbeat?.details);
      const components = parseJsonRecord(details.components);
      const runtimeMetrics = parseJsonRecord(details.metrics);
      const articleExtraction = parseJsonRecord(runtimeMetrics.articleExtraction);
      const jobResults = parseJsonRecord(runtimeMetrics.jobResults);
      const heartbeatAt = heartbeat?.last_seen_at ?? null;
      const heartbeatAge = heartbeatAt
        ? Math.max(0, Math.floor((current.getTime() - Date.parse(heartbeatAt)) / 1_000))
        : 86_400;
      const metrics: Array<{ key: string; sampleCount: number; value: number }> = [
        { key: "api.availability", sampleCount: 1, value: 1 },
        {
          key: "worker.heartbeat_age_seconds",
          sampleCount: heartbeat ? 1 : 0,
          value: heartbeatAge,
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
      const windowEnd = current.toISOString();
      const windowStart = new Date(current.getTime() - 10 * 60_000).toISOString();
      await database.batch(
        metrics.map(({ key, sampleCount, value }) =>
          database
            .prepare(
              `INSERT INTO operations_metric_samples
               (metric_key, dimensions, window_start, window_end, value, sample_count,
                deployment_version, collected_at)
               VALUES (?, '{}', ?, ?, ?, ?, ?, ?)
               ON CONFLICT(metric_key, dimensions, window_end) DO UPDATE SET
                 value = excluded.value, sample_count = excluded.sample_count,
                 deployment_version = excluded.deployment_version,
                 collected_at = excluded.collected_at`,
            )
            .bind(
              key,
              windowStart,
              windowEnd,
              value,
              sampleCount,
              deploymentVersion,
              windowEnd,
            ),
        ),
      );
      await persistCandidateAlerts({
        database,
        deploymentVersion,
        metrics,
        observedAt: windowEnd,
      });
      await captureDailyRetentionSamples({
        database,
        deploymentVersion,
        observedAt: current,
        service,
      });
      console.log(JSON.stringify({
        description: "生产运维低基数指标已聚合",
        event: "operations.metrics.captured",
        metricCount: metrics.length,
        windowEnd,
      }));
    },

    async createReplayPlan({ idempotencyKey, jobId, validation }) {
      const state = await database
        .prepare(
          `SELECT
             j.status AS job_status,
             j.updated_at AS job_updated_at,
             d.created_at AS dead_letter_created_at,
             d.envelope_job_id AS envelope_job_id,
             e.status AS envelope_status,
             e.updated_at AS envelope_updated_at,
             (SELECT MAX(updated_at) FROM worker_effects WHERE job_id = ?) AS effect_updated_at,
             (SELECT MAX(updated_at) FROM worker_replay_operations WHERE job_id = ?) AS replay_updated_at
           FROM worker_jobs j
           LEFT JOIN worker_dead_letters d ON d.job_id = j.job_id
           LEFT JOIN worker_job_envelopes e ON e.job_id = d.envelope_job_id
           WHERE j.job_id = ?`,
        )
        .bind(jobId, jobId, jobId)
        .first<Record<string, unknown>>();
      const canonical = JSON.stringify({
        idempotencyKey,
        jobId,
        state: state ?? null,
        validation: {
          published: validation.published,
          reason: validation.reason,
          replayable: validation.replayable,
          status: validation.status,
        },
      });
      return {
        idempotencyKey,
        jobId,
        planHash: await sha256Hex(canonical),
        ...validation,
      };
    },

    async getDlqConsistency() {
      const freezeAt = now().toISOString();
      const [deadLetters, jobs, envelopes, replayed] = await Promise.all([
        database
          .prepare(
            `SELECT job_id, envelope_job_id, payload_digest
             FROM worker_dead_letters WHERE created_at <= ? ORDER BY job_id`,
          )
          .bind(freezeAt)
          .all<{
            envelope_job_id: string | null;
            job_id: string;
            payload_digest: string;
          }>(),
        database
          .prepare("SELECT job_id, status FROM worker_jobs")
          .all<{ job_id: string; status: string }>(),
        database
          .prepare("SELECT job_id, payload_digest, status FROM worker_job_envelopes")
          .all<{ job_id: string; payload_digest: string; status: string }>(),
        database
          .prepare(
            `SELECT job_id FROM worker_replay_operations
             WHERE status = 'published' GROUP BY job_id`,
          )
          .all<{ job_id: string }>(),
      ]);
      const jobsById = new Map(jobs.results.map((row) => [row.job_id, row.status]));
      const envelopesById = new Map(envelopes.results.map((row) => [row.job_id, row]));
      const replayedIds = new Set(replayed.results.map(({ job_id }) => job_id));
      const deadLetterIds = new Set(deadLetters.results.map(({ job_id }) => job_id));
      const categorized = emptyConsistencySamples();

      for (const deadLetter of deadLetters.results) {
        const jobStatus = jobsById.get(deadLetter.job_id);
        const envelope = deadLetter.envelope_job_id
          ? envelopesById.get(deadLetter.envelope_job_id)
          : undefined;
        const category = classifyDeadLetter({
          deadLetter,
          envelope,
          jobStatus,
          replayed: replayedIds.has(deadLetter.job_id),
        });
        categorized[category].push(deadLetter.job_id);
      }
      for (const job of jobs.results) {
        if (job.status === "dead" && !deadLetterIds.has(job.job_id)) {
          categorized.dead_without_dlq.push(job.job_id);
        }
      }

      return {
        counts: mapConsistencyValues((category) => categorized[category].length),
        deploymentVersion,
        freezeAt,
        samples: mapConsistencyValues((category) =>
          categorized[category].sort().slice(0, 20),
        ),
        totals: {
          deadJobs: jobs.results.filter(({ status }) => status === "dead").length,
          deadLetters: deadLetters.results.length,
        },
        unexplainedCount: 0,
      };
    },

    async getHealthComponents() {
      const current = now();
      const heartbeat = await latestHeartbeat(database);
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
          observedAt:
            typeof value.observedAt === "string"
              ? value.observedAt
              : heartbeat?.last_seen_at ?? current.toISOString(),
          reasonCode:
            typeof value.reasonCode === "string"
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
            deploymentVersion:
              typeof details.deploymentVersion === "string"
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

    async getMetrics({ windowHours }) {
      const current = now();
      const cutoff = new Date(current.getTime() - windowHours * 60 * 60_000).toISOString();
      const rows = await database
        .prepare(
          `SELECT metric_key, value, window_end
           FROM operations_metric_samples
           WHERE window_end >= ? ORDER BY metric_key, window_end`,
        )
        .bind(cutoff)
        .all<{ metric_key: string; value: number; window_end: string }>();
      const grouped = new Map<string, Array<{ at: string; value: number }>>();
      for (const row of rows.results) {
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
        windowHours,
      };
    },

    async getQueueSummary() {
      const current = now();
      const freezeAt = current.toISOString();
      const [inboxCounts, jobCounts, oldestExecutable, earliestDeferred] = await Promise.all([
        database
          .prepare(
            `SELECT
               CASE
                 WHEN status = 'leased' THEN 'processing'
                 WHEN available_at <= ? THEN 'executable'
                 ELSE 'deferred'
               END AS status,
               COUNT(*) AS count
             FROM worker_inbox GROUP BY 1`,
          )
          .bind(freezeAt)
          .all<CountRow>(),
        database
          .prepare("SELECT status, COUNT(*) AS count FROM worker_jobs GROUP BY status")
          .all<CountRow>(),
        database
          .prepare(
            `SELECT MIN(created_at) AS oldest_at FROM worker_inbox
             WHERE status = 'queued' AND available_at <= ?`,
          )
          .bind(freezeAt)
          .first<{ oldest_at: string | null }>(),
        database
          .prepare(
            `SELECT MIN(available_at) AS earliest_at FROM worker_inbox
             WHERE status = 'queued' AND available_at > ?`,
          )
          .bind(freezeAt)
          .first<{ earliest_at: string | null }>(),
      ]);
      const inbox = countsByStatus(inboxCounts.results);
      const jobs = countsByStatus(jobCounts.results);
      const oldestAt = oldestExecutable?.oldest_at ?? null;

      return {
        categories: {
          deferred: inbox.deferred ?? 0,
          executable: inbox.executable ?? 0,
          nonExecutable: (jobs.dead ?? 0) + (jobs.uncertain ?? 0),
          processing: inbox.processing ?? 0,
        },
        deploymentVersion,
        earliestDeferredAt: earliestDeferred?.earliest_at ?? null,
        freezeAt,
        jobStatusCounts: jobs,
        oldestExecutableAgeSeconds:
          oldestAt === null
            ? null
            : Math.max(0, Math.floor((current.getTime() - Date.parse(oldestAt)) / 1_000)),
      };
    },

    async getRetentionReport({ retentionDays }) {
      const current = now();
      const cutoffAt = new Date(
        current.getTime() - retentionDays * 24 * 60 * 60 * 1_000,
      ).toISOString();
      const definitions = [
        ["heartbeats", "worker_heartbeats", "last_seen_at", "心跳可重建，但影响在线历史趋势"],
        ["completedJobs", "worker_jobs", "finished_at", "任务终态影响对账与重试审计", "status = 'done'"],
        ["envelopes", "worker_job_envelopes", "updated_at", "信封决定死信可恢复性"],
        ["deadLetters", "worker_dead_letters", "created_at", "死信属于故障审计证据"],
        ["replayAudit", "worker_replay_operations", "updated_at", "重放记录保护运维幂等"],
        ["effects", "worker_effects", "updated_at", "effect 记录保护外部副作用幂等"],
      ] as const;
      const reports = await Promise.all(
        definitions.map(async ([key, table, timeColumn, risk, where]) => {
          const filter = where ? `WHERE ${where}` : "";
          const row = await database
            .prepare(
              `SELECT COUNT(*) AS total,
                      SUM(CASE WHEN ${timeColumn} < ? THEN 1 ELSE 0 END) AS candidates,
                      MIN(${timeColumn}) AS oldest_at, MAX(${timeColumn}) AS latest_at
               FROM ${table} ${filter}`,
            )
            .bind(cutoffAt)
            .first<TimeSummaryRow>();
          return [key, normalizeRetentionRow(row, risk)] as const;
        }),
      );
      return {
        cutoffAt,
        dryRun: true,
        generatedAt: current.toISOString(),
        resources: Object.fromEntries(reports),
        retentionDays,
      };
    },
  };
  return service;
}

function classifyDeadLetter(input: {
  readonly deadLetter: {
    readonly envelope_job_id: string | null;
    readonly job_id: string;
    readonly payload_digest: string;
  };
  readonly envelope:
    | { readonly job_id: string; readonly payload_digest: string; readonly status: string }
    | undefined;
  readonly jobStatus: string | undefined;
  readonly replayed: boolean;
}): ConsistencyCategory {
  if (input.jobStatus === undefined) return "orphan_dlq";
  if (input.replayed) return "already_replayed";
  if (input.jobStatus !== "dead") return "historical_migration";
  if (!input.deadLetter.envelope_job_id || !input.envelope) return "missing_envelope";
  if (
    input.envelope.job_id !== input.deadLetter.job_id ||
    input.envelope.status !== "dead" ||
    input.envelope.payload_digest !== input.deadLetter.payload_digest
  ) {
    return "integrity_anomaly";
  }
  return "matched";
}

function countsByStatus(rows: readonly CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map(({ count, status }) => [status, Number(count)]));
}

function emptyConsistencySamples(): Record<ConsistencyCategory, string[]> {
  return mapConsistencyValues(() => [] as string[]);
}

function mapConsistencyValues<T>(
  mapper: (category: ConsistencyCategory) => T,
): Record<ConsistencyCategory, T> {
  return {
    already_replayed: mapper("already_replayed"),
    dead_without_dlq: mapper("dead_without_dlq"),
    historical_migration: mapper("historical_migration"),
    integrity_anomaly: mapper("integrity_anomaly"),
    matched: mapper("matched"),
    missing_envelope: mapper("missing_envelope"),
    orphan_dlq: mapper("orphan_dlq"),
  };
}

function normalizeRetentionRow(
  row: TimeSummaryRow | null,
  risk: string,
): RetentionResourceReport {
  return {
    candidates: Number(row?.candidates ?? 0),
    latestAt: row?.latest_at ?? null,
    oldestAt: row?.oldest_at ?? null,
    risk,
    total: Number(row?.total ?? 0),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function evaluateThreshold(input: {
  readonly comparison: "gt" | "lt";
  readonly current: number;
  readonly previousState: CandidateAlertState | null;
  readonly threshold: number;
}): {
  readonly state: CandidateAlertState | null;
  readonly transition: CandidateAlertState | null;
} {
  const breached = input.comparison === "gt"
    ? input.current > input.threshold
    : input.current < input.threshold;
  if (breached) {
    if (input.previousState === "firing") {
      return { state: "firing", transition: null };
    }
    if (input.previousState === "pending") {
      return { state: "firing", transition: "firing" };
    }
    return { state: "pending", transition: "pending" };
  }
  if (input.previousState === "firing") {
    return { state: "recovered", transition: "recovered" };
  }
  return { state: null, transition: null };
}

function metricCounters(
  prefix: string,
  source: Readonly<Record<string, unknown>>,
  names: Readonly<Record<string, string>>,
): Array<{ key: string; sampleCount: number; value: number }> {
  return Object.entries(names).map(([sourceKey, metricName]) => {
    const value = source[sourceKey];
    return {
      key: `${prefix}.${metricName}`,
      sampleCount: typeof value === "number" ? 1 : 0,
      value: typeof value === "number" ? value : 0,
    };
  });
}

function candidateThreshold(key: string): {
  readonly comparison: "gt" | "lt";
  readonly state: "candidate";
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
  const threshold = thresholds[key];
  return threshold ? { ...threshold, state: "candidate" } : null;
}

async function persistCandidateAlerts(input: {
  readonly database: D1Database;
  readonly deploymentVersion: string;
  readonly metrics: readonly CandidateMetric[];
  readonly observedAt: string;
}): Promise<void> {
  const existing = await input.database
    .prepare(
      "SELECT policy_key, state, last_evaluated_at FROM operations_alert_instances",
    )
    .all<AlertInstanceRow>();
  const previousByPolicy = new Map(
    existing.results.map((row) => [row.policy_key, row]),
  );
  const statements: D1PreparedStatement[] = [];
  const transitions: Array<{
    readonly statementIndex: number;
    readonly policyKey: string;
    readonly state: CandidateAlertState;
  }> = [];

  for (const metric of input.metrics) {
    const threshold = candidateThreshold(metric.key);
    if (!threshold || metric.sampleCount === 0) continue;
    const previous = previousByPolicy.get(metric.key);
    if (previous?.last_evaluated_at === input.observedAt) continue;
    const previousState = previous?.state ?? null;
    const decision = evaluateThreshold({
      comparison: threshold.comparison,
      current: metric.value,
      previousState,
      threshold: threshold.value,
    });
    if (decision.state === null) {
      if (previousState !== null) {
        statements.push(
          input.database
            .prepare("DELETE FROM operations_alert_instances WHERE policy_key = ?")
            .bind(metric.key),
        );
      }
      continue;
    }
    statements.push(
      input.database
        .prepare(
          `INSERT INTO operations_alert_instances
           (policy_key, comparison, threshold_value, state, observed_value,
            first_observed_at, last_evaluated_at, last_transition_at, deployment_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(policy_key) DO UPDATE SET
             comparison = excluded.comparison,
             threshold_value = excluded.threshold_value,
             state = excluded.state,
             observed_value = excluded.observed_value,
             first_observed_at = CASE
               WHEN operations_alert_instances.state = 'recovered'
                    AND excluded.state = 'pending' THEN excluded.first_observed_at
               ELSE operations_alert_instances.first_observed_at
             END,
             last_evaluated_at = excluded.last_evaluated_at,
             last_transition_at = CASE
               WHEN operations_alert_instances.state <> excluded.state
                 THEN excluded.last_transition_at
               ELSE operations_alert_instances.last_transition_at
             END,
             deployment_version = excluded.deployment_version`,
        )
        .bind(
          metric.key,
          threshold.comparison,
          threshold.value,
          decision.state,
          metric.value,
          input.observedAt,
          input.observedAt,
          input.observedAt,
          input.deploymentVersion,
        ),
    );
    if (decision.transition !== null) {
      statements.push(
        input.database
          .prepare(
            `INSERT OR IGNORE INTO operations_alert_events
             (event_key, policy_key, state, comparison, threshold_value,
              observed_value, occurred_at, deployment_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `${metric.key}:${decision.transition}:${input.observedAt}`,
            metric.key,
            decision.transition,
            threshold.comparison,
            threshold.value,
            metric.value,
            input.observedAt,
            input.deploymentVersion,
          ),
      );
      transitions.push({
        policyKey: metric.key,
        state: decision.transition,
        statementIndex: statements.length - 1,
      });
    }
  }

  const results = statements.length > 0 ? await input.database.batch(statements) : [];
  for (const transition of transitions) {
    if (Number(results[transition.statementIndex]?.meta?.changes ?? 0) === 0) continue;
    console.log(JSON.stringify({
      description: "候选告警状态已进入脱敏审计，未发送外部通知",
      event: `operations.alert_candidate.${transition.state}`,
      policyKey: transition.policyKey,
      service: "api",
      state: transition.state,
    }));
  }
}

async function captureDailyRetentionSamples(input: {
  readonly database: D1Database;
  readonly deploymentVersion: string;
  readonly observedAt: Date;
  readonly service: OperationsReadinessService;
}): Promise<void> {
  const sampleDate = input.observedAt.toISOString().slice(0, 10);
  const reports = await Promise.all(
    [7, 30, 90].map((retentionDays) =>
      input.service.getRetentionReport({ retentionDays })
    ),
  );
  const statements = reports.flatMap((report) =>
    Object.entries(report.resources).map(([recordKind, resource]) =>
      input.database
        .prepare(
          `INSERT INTO operations_retention_samples
           (sample_date, record_kind, window_days, cutoff_at, candidate_count,
            oldest_candidate_at, captured_at, deployment_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sample_date, record_kind, window_days) DO UPDATE SET
             cutoff_at = excluded.cutoff_at,
             candidate_count = excluded.candidate_count,
             oldest_candidate_at = excluded.oldest_candidate_at,
             captured_at = excluded.captured_at,
             deployment_version = excluded.deployment_version`,
        )
        .bind(
          sampleDate,
          recordKind,
          report.retentionDays,
          report.cutoffAt,
          resource.candidates,
          resource.candidates > 0 ? resource.oldestAt : null,
          report.generatedAt,
          input.deploymentVersion,
        )
    ),
  );
  await input.database.batch(statements);
  console.log(JSON.stringify({
    description: "候选保留窗口每日聚合样本已幂等保存",
    event: "operations.retention.sampled",
    sampleCount: statements.length,
    sampleDate,
    service: "api",
  }));
}

async function latestHeartbeat(database: D1Database): Promise<{
  readonly details: string;
  readonly last_seen_at: string;
} | null> {
  return database
    .prepare(
      "SELECT details, last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1",
    )
    .first<{ details: string; last_seen_at: string }>();
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

function isHealthState(value: unknown): value is HealthComponentState {
  return ["starting", "ready", "degraded", "stopping", "failed"].includes(
    String(value),
  );
}
