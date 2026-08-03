import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import {
  createD1OperationsReadinessService,
  evaluateThreshold,
} from "../src/operations-readiness";
import { createD1TestDatabase } from "./d1-test-adapter";

const now = new Date("2030-01-01T00:00:00.000Z");
let observedNow = now;

describe("production operations readiness queries", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    observedNow = now;
    sqlite = new DatabaseSync(":memory:");
    for (const migration of [
      "0001_initial.sql",
      "0002_worker_runtime.sql",
      "0003_queue_inbox.sql",
      "0004_article_retry_safety.sql",
      "0005_operations_readiness.sql",
      "0006_operations_metrics.sql",
      "0007_operations_baselines.sql",
    ]) {
      sqlite.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
  });

  function service() {
    return createD1OperationsReadinessService({
      database: createD1TestDatabase(sqlite),
      deploymentVersion: "test-version",
      now: () => observedNow,
    });
  }

  it("互斥统计可执行、处理中、延期与不可执行，并计算最老年龄", async () => {
    sqlite.exec(`
      INSERT INTO worker_inbox
        (message_id, body, status, attempts, lease_id, lease_until, available_at,
         timestamp_ms, created_at, updated_at)
      VALUES
        ('executable', '{}', 'queued', 0, NULL, NULL,
         '2029-12-31T23:59:00.000Z', 1, '2029-12-31T23:50:00.000Z',
         '2029-12-31T23:50:00.000Z'),
        ('deferred', '{}', 'queued', 1, NULL, NULL,
         '2030-01-01T00:05:00.000Z', 2, '2029-12-31T23:55:00.000Z',
         '2029-12-31T23:55:00.000Z'),
        ('processing', '{}', 'leased', 1, 'lease-1', '2030-01-01T00:01:00.000Z',
         '2029-12-31T23:59:00.000Z', 3, '2029-12-31T23:58:00.000Z',
         '2029-12-31T23:59:00.000Z');
      INSERT INTO worker_jobs
        (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at)
      VALUES
        ('dead-key', 'dead-job', 'dispatch-item', 'link', 'dead', 3,
         '2029-12-30T00:00:00.000Z', '2029-12-31T00:00:00.000Z'),
        ('uncertain-key', 'uncertain-job', 'dispatch-item', 'article', 'uncertain', 1,
         '2029-12-31T00:00:00.000Z', '2029-12-31T01:00:00.000Z');
    `);

    const summary = await service().getQueueSummary();

    expect(summary.categories).toEqual({
      deferred: 1,
      executable: 1,
      nonExecutable: 2,
      processing: 1,
    });
    expect(summary.oldestExecutableAgeSeconds).toBe(600);
    expect(summary.earliestDeferredAt).toBe("2030-01-01T00:05:00.000Z");
    expect(summary.deploymentVersion).toBe("test-version");
  });

  it("将 DLQ、dead、envelope 与 replay 全量归入七类且只读", async () => {
    const jobs = [
      ["matched", "dead"],
      ["missing", "dead"],
      ["dead-only", "dead"],
      ["historical", "done"],
      ["replayed", "failed"],
      ["anomaly", "dead"],
    ] as const;
    for (const [id, status] of jobs) {
      sqlite.prepare(
        `INSERT INTO worker_jobs
         (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'dispatch-item', 'article', ?, 3, ?, ?)`,
      ).run(`key-${id}`, id, status, now.toISOString(), now.toISOString());
    }
    for (const id of ["matched", "missing", "orphan", "historical", "replayed", "anomaly"]) {
      sqlite.prepare(
        `INSERT INTO worker_dead_letters
         (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
          payload_digest, envelope_job_id, created_at)
         VALUES (?, ?, 'dispatch-item', 'article', 3, 'retryable', 'synthetic', ?, ?, ?)`,
      ).run(
        id,
        `key-${id}`,
        id === "anomaly" ? "digest-dlq" : `digest-${id}`,
        ["matched", "anomaly"].includes(id) ? id : null,
        now.toISOString(),
      );
    }
    for (const id of ["matched", "anomaly"]) {
      sqlite.prepare(
        `INSERT INTO worker_job_envelopes
         (job_id, dedupe_key, schema_version, payload_digest, ciphertext, status,
          created_at, updated_at)
         VALUES (?, ?, 1, ?, X'01', 'dead', ?, ?)`,
      ).run(
        id,
        `key-${id}`,
        id === "anomaly" ? "digest-envelope" : `digest-${id}`,
        now.toISOString(),
        now.toISOString(),
      );
    }
    sqlite.prepare(
      `INSERT INTO worker_replay_operations
       (idempotency_key, job_id, message_id, status, reason, created_at, updated_at)
       VALUES ('op-replayed', 'replayed', 'message-replayed', 'published', 'published', ?, ?)`,
    ).run(now.toISOString(), now.toISOString());
    const before = sqlite.prepare("SELECT COUNT(*) AS count FROM worker_dead_letters").get();

    const report = await service().getDlqConsistency();

    expect(report.counts).toEqual({
      already_replayed: 1,
      dead_without_dlq: 1,
      historical_migration: 1,
      integrity_anomaly: 1,
      matched: 1,
      missing_envelope: 1,
      orphan_dlq: 1,
    });
    expect(report.unexplainedCount).toBe(0);
    expect(report.totals).toEqual({ deadJobs: 4, deadLetters: 6 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_dead_letters").get()).toEqual(
      before,
    );
  });

  it("retention report 只报告候选范围、时间和幂等风险，不删除记录", async () => {
    sqlite.exec(`
      INSERT INTO worker_heartbeats (worker_id, last_seen_at, details)
      VALUES ('old-worker', '2029-01-01T00:00:00.000Z', '{}'),
             ('new-worker', '2029-12-31T23:59:00.000Z', '{}');
      INSERT INTO worker_jobs
        (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at,
         finished_at)
      VALUES
        ('old-done', 'old-done', 'dispatch-item', 'link', 'done', 1,
         '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z',
         '2029-01-01T00:00:00.000Z'),
        ('new-done', 'new-done', 'dispatch-item', 'link', 'done', 1,
         '2029-12-31T23:59:00.000Z', '2029-12-31T23:59:00.000Z',
         '2029-12-31T23:59:00.000Z'),
        ('old-processing', 'old-processing', 'dispatch-item', 'link', 'processing', 1,
         '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z',
         '2029-01-01T00:00:00.000Z');
      INSERT INTO worker_job_envelopes
        (job_id, dedupe_key, schema_version, payload_digest, ciphertext, status,
         created_at, updated_at)
      VALUES
        ('old-envelope', 'old-envelope', 1, '${"a".repeat(64)}', X'01', 'dead',
         '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z'),
        ('new-envelope', 'new-envelope', 1, '${"b".repeat(64)}', X'02', 'active',
         '2029-12-31T23:59:00.000Z', '2029-12-31T23:59:00.000Z');
      INSERT INTO worker_dead_letters
        (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
         payload_digest, created_at)
      VALUES
        ('old-dead', 'old-dead', 'dispatch-item', 'link', 3, 'retryable', 'synthetic',
         '${"c".repeat(64)}', '2029-01-01T00:00:00.000Z'),
        ('new-dead', 'new-dead', 'dispatch-item', 'link', 3, 'retryable', 'synthetic',
         '${"d".repeat(64)}', '2029-12-31T23:59:00.000Z');
      INSERT INTO worker_replay_operations
        (idempotency_key, job_id, message_id, status, reason, created_at, updated_at)
      VALUES
        ('old-replay', 'old-dead', 'old-message', 'published', 'synthetic',
         '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z'),
        ('new-replay', 'new-dead', 'new-message', 'rejected', 'synthetic',
         '2029-12-31T23:59:00.000Z', '2029-12-31T23:59:00.000Z');
      INSERT INTO worker_effects
        (effect_key, job_id, destination, status, attempts, updated_at, finished_at)
      VALUES
        ('old-effect', 'old-done', 'archive', 'done', 1,
         '2029-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z'),
        ('new-effect', 'new-done', 'archive', 'done', 1,
         '2029-12-31T23:59:00.000Z', '2029-12-31T23:59:00.000Z');
    `);
    const retainedTables = [
      "worker_heartbeats",
      "worker_jobs",
      "worker_job_envelopes",
      "worker_dead_letters",
      "worker_replay_operations",
      "worker_effects",
    ] as const;
    const before = Object.fromEntries(
      retainedTables.map((table) => [
        table,
        sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ]),
    );

    const report = await service().getRetentionReport({ retentionDays: 30 });

    expect(report.dryRun).toBe(true);
    expect(report.resources).toMatchObject({
      completedJobs: { candidates: 1, total: 2 },
      deadLetters: { candidates: 1, total: 2 },
      effects: { candidates: 1, total: 2 },
      envelopes: { candidates: 1, total: 2 },
      heartbeats: { candidates: 1, total: 2 },
      replayAudit: { candidates: 1, total: 2 },
    });
    expect(
      Object.values(report.resources).every(
        ({ latestAt, oldestAt }) =>
          latestAt === "2029-12-31T23:59:00.000Z" &&
          oldestAt === "2029-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(report.resources.effects?.risk).toContain("幂等");
    expect(
      Object.fromEntries(
        retainedTables.map((table) => [
          table,
          sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ]),
      ),
    ).toEqual(before);
  });

  it("retention 查询计划只扫描覆盖索引", () => {
    const cases = [
      ["worker_heartbeats", "last_seen_at", "", "worker_heartbeats_last_seen_idx"],
      ["worker_jobs", "finished_at", "WHERE status = 'done'", "worker_jobs_retention_idx"],
      ["worker_job_envelopes", "updated_at", "", "worker_job_envelopes_status_idx"],
      ["worker_dead_letters", "created_at", "", "worker_dead_letters_created_idx"],
      [
        "worker_replay_operations",
        "updated_at",
        "",
        "worker_replay_operations_updated_idx",
      ],
      ["worker_effects", "updated_at", "", "worker_effects_status_idx"],
    ] as const;

    for (const [table, timeColumn, filter, index] of cases) {
      const plan = sqlite
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT COUNT(*) AS total,
                  SUM(CASE WHEN ${timeColumn} < ? THEN 1 ELSE 0 END) AS candidates,
                  MIN(${timeColumn}) AS oldest_at, MAX(${timeColumn}) AS latest_at
           FROM ${table} ${filter}`,
        )
        .all("2029-12-02T00:00:00.000Z") as Array<{ detail: string }>;

      expect(plan.map(({ detail }) => detail).join(" ")).toContain(
        `USING COVERING INDEX ${index}`,
      );
    }
  });

  it("重放 planHash 绑定同一对象、参数、校验结果与 D1 状态版本", async () => {
    sqlite.exec(`
      INSERT INTO worker_jobs
        (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at)
      VALUES ('key-plan', 'job-plan', 'dispatch-item', 'article', 'dead', 3,
              '2029-12-31T00:00:00.000Z', '2029-12-31T00:00:00.000Z');
      INSERT INTO worker_dead_letters
        (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
         payload_digest, created_at)
      VALUES ('job-plan', 'key-plan', 'dispatch-item', 'article', 3, 'retryable',
              'synthetic', 'digest', '2029-12-31T00:00:00.000Z');
    `);
    const input = {
      idempotencyKey: "operation-plan",
      jobId: "job-plan",
      validation: {
        published: false,
        reason: "replayable",
        replayable: true,
        status: "validated",
      },
    } as const;

    const first = await service().createReplayPlan(input);
    const second = await service().createReplayPlan(input);
    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);

    sqlite.exec(
      "UPDATE worker_jobs SET updated_at = '2029-12-31T01:00:00.000Z' WHERE job_id = 'job-plan'",
    );
    expect((await service().createReplayPlan(input)).planHash).not.toBe(first.planHash);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM worker_replay_operations").get()).toEqual({
      count: 0,
    });
  });

  it("采集低基数指标并返回当前值、趋势、候选阈值、时间和部署版本", async () => {
    sqlite.exec(`
      INSERT INTO worker_heartbeats (worker_id, last_seen_at, details)
      VALUES ('worker-1', '2029-12-31T23:59:30.000Z',
              '{"backlogCount":3,"components":{"browser":{"state":"ready"},"mihomo":{"state":"ready"},"warp":{"state":"degraded"}},"metrics":{"articleExtraction":{"browserSucceeded":2,"directRejected":3,"directSucceeded":7,"failed":1},"jobResults":{"deadLettered":1,"deferred":2,"retryableFailed":3,"succeeded":8,"uncertain":1}}}');
      INSERT INTO worker_inbox
        (message_id, body, status, attempts, available_at, timestamp_ms, created_at, updated_at)
      VALUES ('metric-job', '{}', 'queued', 0, '2029-12-31T23:59:00.000Z', 1,
              '2029-12-31T23:58:00.000Z', '2029-12-31T23:58:00.000Z');
      INSERT INTO worker_jobs
        (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at,
         finished_at)
      VALUES ('metric-done', 'metric-done', 'dispatch-item', 'link', 'done', 1,
              '2029-12-31T23:50:00.000Z', '2029-12-31T23:55:00.000Z',
              '2029-12-31T23:55:00.000Z');
    `);
    const readiness = service();

    await readiness.captureMetrics();
    sqlite.exec(
      "UPDATE worker_heartbeats SET last_seen_at = '2030-01-01T00:00:00.000Z' WHERE worker_id = 'worker-1'",
    );
    observedNow = new Date("2030-01-01T00:10:00.000Z");
    await readiness.captureMetrics();
    const report = await readiness.getMetrics({ windowHours: 24 });

    expect(report.deploymentVersion).toBe("test-version");
    expect(report.generatedAt).toBe("2030-01-01T00:10:00.000Z");
    expect(report.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          current: 600,
          key: "worker.heartbeat_age_seconds",
          threshold: expect.objectContaining({ state: "candidate", value: 90 }),
          trend: expect.arrayContaining([
            expect.objectContaining({ at: "2030-01-01T00:00:00.000Z", value: 30 }),
            expect.objectContaining({ at: "2030-01-01T00:10:00.000Z", value: 600 }),
          ]),
        }),
        expect.objectContaining({ current: 0, key: "dependency.warp.ready" }),
        expect.objectContaining({ current: 1, key: "api.availability" }),
        expect.objectContaining({ current: 7, key: "article.extraction.direct_succeeded" }),
        expect.objectContaining({ current: 2, key: "article.extraction.browser_succeeded" }),
        expect.objectContaining({ current: 8, key: "worker.job.succeeded" }),
      ]),
    );
  });

  it("从最新心跳解析六组件状态，旧格式依赖不会假报 ready", async () => {
    sqlite.exec(`
      INSERT INTO worker_heartbeats (worker_id, last_seen_at, details)
      VALUES ('worker-1', '2029-12-31T23:59:30.000Z',
              '{"components":{"browser":{"state":"ready","reasonCode":"connected","observedAt":"2029-12-31T23:59:20.000Z"}}}');
    `);

    const report = await service().getHealthComponents();

    expect(report.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "api", state: "ready" }),
        expect.objectContaining({ component: "worker", state: "ready" }),
        expect.objectContaining({ component: "browser", state: "ready" }),
        expect.objectContaining({
          component: "mihomo",
          reasonCode: "legacy_heartbeat_missing_component",
          state: "degraded",
        }),
        expect.objectContaining({ component: "console", state: "degraded" }),
      ]),
    );
  });

  it("同一 UTC 日幂等保存 7/30/90 天 retention 样本，跨日新增一组", async () => {
    const readiness = service();

    await Promise.all([readiness.captureMetrics(), readiness.captureMetrics()]);
    await readiness.captureMetrics();
    expect(
      sqlite.prepare(
        "SELECT COUNT(*) AS count FROM operations_alert_events WHERE state = 'firing'",
      ).get(),
    ).toEqual({ count: 0 });
    observedNow = new Date("2030-01-01T12:00:00.000Z");
    await readiness.captureMetrics();

    expect(
      sqlite.prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT sample_date) AS days
         FROM operations_retention_samples`,
      ).get(),
    ).toEqual({ count: 18, days: 1 });

    observedNow = new Date("2030-01-02T00:00:00.000Z");
    await readiness.captureMetrics();

    expect(
      sqlite.prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT sample_date) AS days
         FROM operations_retention_samples`,
      ).get(),
    ).toEqual({ count: 36, days: 2 });
  });

  it("候选阈值按 pending、firing、recovered 去重审计并最终清除实例", async () => {
    sqlite.exec(`
      INSERT INTO worker_heartbeats (worker_id, last_seen_at, details)
      VALUES ('worker-alert', '2029-12-31T23:50:00.000Z',
              '{"components":{"browser":{"state":"ready"},"mihomo":{"state":"ready"},"warp":{"state":"ready"}}}');
    `);
    const readiness = service();

    await readiness.captureMetrics();
    expect(
      sqlite.prepare(
        `SELECT state FROM operations_alert_instances
         WHERE policy_key = 'worker.heartbeat_age_seconds'`,
      ).get(),
    ).toEqual({ state: "pending" });

    observedNow = new Date("2030-01-01T00:10:00.000Z");
    await readiness.captureMetrics();
    expect(
      sqlite.prepare(
        `SELECT state FROM operations_alert_instances
         WHERE policy_key = 'worker.heartbeat_age_seconds'`,
      ).get(),
    ).toEqual({ state: "firing" });

    observedNow = new Date("2030-01-01T00:20:00.000Z");
    sqlite.exec(
      "UPDATE worker_heartbeats SET last_seen_at = '2030-01-01T00:20:00.000Z' WHERE worker_id = 'worker-alert'",
    );
    await readiness.captureMetrics();
    expect(
      sqlite.prepare(
        `SELECT state FROM operations_alert_instances
         WHERE policy_key = 'worker.heartbeat_age_seconds'`,
      ).get(),
    ).toEqual({ state: "recovered" });

    observedNow = new Date("2030-01-01T00:30:00.000Z");
    sqlite.exec(
      "UPDATE worker_heartbeats SET last_seen_at = '2030-01-01T00:30:00.000Z' WHERE worker_id = 'worker-alert'",
    );
    await readiness.captureMetrics();

    expect(
      sqlite.prepare(
        `SELECT state FROM operations_alert_instances
         WHERE policy_key = 'worker.heartbeat_age_seconds'`,
      ).get(),
    ).toBeUndefined();
    expect(
      sqlite.prepare(
        `SELECT state FROM operations_alert_events
         WHERE policy_key = 'worker.heartbeat_age_seconds' ORDER BY occurred_at`,
      ).all(),
    ).toEqual([{ state: "pending" }, { state: "firing" }, { state: "recovered" }]);
  });

  it("候选阈值状态机只产生脱敏状态转换，不表达外部通知", () => {
    const pending = evaluateThreshold({
      comparison: "gt",
      current: 120,
      previousState: null,
      threshold: 90,
    });
    expect(pending).toEqual({ state: "pending", transition: "pending" });

    const firing = evaluateThreshold({
      comparison: "gt",
      current: 120,
      previousState: "pending",
      threshold: 90,
    });
    expect(firing).toEqual({ state: "firing", transition: "firing" });
    expect(
      evaluateThreshold({
        comparison: "gt",
        current: 130,
        previousState: firing.state,
        threshold: 90,
      }),
    ).toEqual({ state: "firing", transition: null });
    expect(
      evaluateThreshold({
        comparison: "gt",
        current: 30,
        previousState: "firing",
        threshold: 90,
      }),
    ).toEqual({ state: "recovered", transition: "recovered" });
    expect(
      evaluateThreshold({
        comparison: "gt",
        current: 30,
        previousState: "recovered",
        threshold: 90,
      }),
    ).toEqual({ state: null, transition: null });
    expect(
      evaluateThreshold({
        comparison: "gt",
        current: 30,
        previousState: "pending",
        threshold: 90,
      }),
    ).toEqual({ state: null, transition: null });
  });
});
