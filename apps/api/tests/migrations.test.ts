import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const expectedTables = [
  "article_archive_events",
  "credentials",
  "dida_sync_states",
  "incremental_baselines",
  "login_sessions",
  "operations_snapshots",
  "subscriptions",
  "sync_jobs",
  "telegram_offsets",
  "worker_dead_letters",
  "worker_effects",
  "worker_heartbeats",
  "worker_inbox",
  "worker_job_envelopes",
  "worker_jobs",
  "worker_rate_limit_batches",
  "worker_rate_limits",
  "worker_replay_operations",
  "worker_state",
] as const;

describe("D1 migrations", () => {
  it("空数据库按版本顺序应用 migration 并保持旧 migration 可重复", () => {
    const database = new DatabaseSync(":memory:");
    const initialMigration = readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );
    const runtimeMigration = readFileSync(
      new URL("../migrations/0002_worker_runtime.sql", import.meta.url),
      "utf8",
    );
    const inboxMigration = readFileSync(
      new URL("../migrations/0003_queue_inbox.sql", import.meta.url),
      "utf8",
    );
    const retrySafetyMigration = readFileSync(
      new URL("../migrations/0004_article_retry_safety.sql", import.meta.url),
      "utf8",
    );

    database.exec(initialMigration);
    database.exec(runtimeMigration);
    database.exec(inboxMigration);
    database.exec(initialMigration);
    database.exec(runtimeMigration);
    database.exec(inboxMigration);
    database.exec(retrySafetyMigration);

    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(rows.map(({ name }) => name));
    expect(expectedTables.every((name) => tableNames.has(name))).toBe(true);
  });

  it("升级到 0004 后仍保留历史 DLQ 原字段", () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "0001_initial.sql",
      "0002_worker_runtime.sql",
      "0003_queue_inbox.sql",
    ]) {
      database.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
    database.exec(
      `INSERT INTO worker_dead_letters
       (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
        payload_digest, created_at)
       VALUES ('historical-job', 'dispatch:article:old', 'dispatch-item', 'article', 3,
               'retryable', 'effect temporarily busy', '${"a".repeat(64)}',
               '2026-08-02T18:00:00.000Z')`,
    );
    const migration = readFileSync(
      new URL("../migrations/0004_article_retry_safety.sql", import.meta.url),
      "utf8",
    );

    database.exec(migration);

    expect(
      database.prepare(
        `SELECT job_id, dedupe_key, attempts, error_message, payload_digest, created_at,
                envelope_job_id
         FROM worker_dead_letters WHERE job_id = 'historical-job'`,
      ).get(),
    ).toEqual({
      attempts: 3,
      created_at: "2026-08-02T18:00:00.000Z",
      dedupe_key: "dispatch:article:old",
      envelope_job_id: null,
      error_message: "effect temporarily busy",
      job_id: "historical-job",
      payload_digest: "a".repeat(64),
    });
  });

  it("升级后旧版 worker 写入契约仍可用于代码回滚", () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "0001_initial.sql",
      "0002_worker_runtime.sql",
      "0003_queue_inbox.sql",
      "0004_article_retry_safety.sql",
    ]) {
      database.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }

    database.exec(
      `INSERT INTO worker_jobs
       (dedupe_key, job_id, kind, item_kind, status, attempts, created_at, updated_at)
       VALUES ('dispatch:link:rollback', 'rollback-job', 'dispatch-item', 'link',
               'processing', 1, '2030-01-01T00:00:00.000Z',
               '2030-01-01T00:00:00.000Z');
       INSERT INTO worker_dead_letters
       (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
        payload_digest, created_at)
       VALUES ('rollback-dead', 'dispatch:link:rollback-dead', 'dispatch-item', 'link',
               3, 'retryable', 'synthetic', '${"b".repeat(64)}',
               '2030-01-01T00:00:00.000Z');`,
    );

    expect(
      database
        .prepare(
          `SELECT failure_attempts, deferral_count FROM worker_jobs
           WHERE job_id = 'rollback-job'`,
        )
        .get(),
    ).toEqual({ deferral_count: 0, failure_attempts: 0 });
    expect(
      database
        .prepare(
          `SELECT envelope_job_id FROM worker_dead_letters
           WHERE job_id = 'rollback-dead'`,
        )
        .get(),
    ).toEqual({ envelope_job_id: null });
  });
});
