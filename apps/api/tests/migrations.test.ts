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
  "worker_jobs",
  "worker_rate_limits",
  "worker_state",
] as const;

describe("D1 migrations", () => {
  it("空数据库可重复应用版本化 migration", () => {
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

    database.exec(initialMigration);
    database.exec(runtimeMigration);
    database.exec(inboxMigration);
    database.exec(initialMigration);
    database.exec(runtimeMigration);
    database.exec(inboxMigration);

    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(rows.map(({ name }) => name));
    expect(expectedTables.every((name) => tableNames.has(name))).toBe(true);
  });
});
