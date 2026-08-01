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
] as const;

describe("D1 migrations", () => {
  it("空数据库可重复应用版本化 migration", () => {
    const database = new DatabaseSync(":memory:");
    const migration = readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );

    database.exec(migration);
    database.exec(migration);

    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = new Set(rows.map(({ name }) => name));
    expect(expectedTables.every((name) => tableNames.has(name))).toBe(true);
  });
});
