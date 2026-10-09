import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHyperdrivePostgresPool } from "../src/postgres-connection";
import { createQueueInboxPostgresService } from "../src/queue-inbox-postgres";

const rawDatabaseUrl = process.env.INBOX_TEST_POSTGRES_URL;
const databaseUrl = rawDatabaseUrl ? localTestDatabaseUrl(rawDatabaseUrl) : undefined;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL 17.6 queue inbox integration", () => {
  let setupClient: Client | undefined;
  let schemaReady = false;
  let service: ReturnType<typeof createQueueInboxPostgresService>;
  const messageIds: string[] = [];

  beforeAll(async () => {
    setupClient = new Client({ connectionString: databaseUrl });
    await setupClient.connect();
    const version = await setupClient.query<{ version_num: number }>(
      "SELECT current_setting('server_version_num')::int AS version_num",
    );
    if (version.rows[0]?.version_num !== 170006) {
      throw new Error("INBOX_TEST_POSTGRES_URL must point to PostgreSQL 17.6");
    }

    const migration = readFileSync(
      new URL("../postgres-migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );
    await setupClient.query(migration);
    schemaReady = true;
    const existing = await setupClient.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM inbox_server.worker_inbox",
    );
    if (existing.rows[0]?.count !== "0") {
      throw new Error("The isolated PostgreSQL test database must have an empty worker inbox");
    }

    service = createQueueInboxPostgresService({
      pool: createHyperdrivePostgresPool({ connectionString: databaseUrl! }),
    });
  });

  afterAll(async () => {
    if (setupClient === undefined) return;
    try {
      if (schemaReady && messageIds.length > 0) {
        await setupClient.query(
          "DELETE FROM inbox_server.worker_inbox WHERE message_id = ANY($1::text[])",
          [messageIds],
        );
      }
    } finally {
      await setupClient.end();
    }
  });

  it("deduplicates, grants one concurrent lease, settles, and rolls back a failed batch", async () => {
    const messageId = track("concurrent");
    const message = {
      body: { kind: "synthetic-test", marker: messageId },
      id: messageId,
      timestampMs: Date.now(),
    };
    await service.stage([message]);
    await service.stage([{ ...message, body: { kind: "must-not-replace-first" } }]);

    const stored = await setupClient!.query<{ body: string }>(
      "SELECT body FROM inbox_server.worker_inbox WHERE message_id = $1",
      [messageId],
    );
    expect(stored.rows).toEqual([{ body: JSON.stringify(message.body) }]);

    const [left, right] = await Promise.all([
      service.pull({ batchSize: 1, visibilityTimeoutMs: 60_000 }),
      service.pull({ batchSize: 1, visibilityTimeoutMs: 60_000 }),
    ]);
    const leases = [...left.messages, ...right.messages];
    expect(leases).toHaveLength(1);
    expect(leases[0]?.id).toBe(messageId);

    await service.settle({ acks: [], retries: [{ leaseId: leases[0]!.leaseId }] });
    const retried = await service.pull({ batchSize: 1, visibilityTimeoutMs: 60_000 });
    expect(retried.messages).toHaveLength(1);
    expect(retried.messages[0]).toMatchObject({ id: messageId, attempts: 2 });
    await service.settle({ acks: [retried.messages[0]!.leaseId], retries: [] });

    const rollbackId = track("rollback");
    await expect(service.stage([
      { body: { kind: "must-roll-back" }, id: rollbackId, timestampMs: Date.now() },
      { body: { unsupported: 1n }, id: track("rollback-error"), timestampMs: Date.now() },
    ])).rejects.toThrow();
    const rolledBack = await setupClient!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM inbox_server.worker_inbox WHERE message_id = $1",
      [rollbackId],
    );
    expect(rolledBack.rows[0]?.count).toBe("0");
  });

  function track(label: string): string {
    const id = `integration-${label}-${crypto.randomUUID()}`;
    messageIds.push(id);
    return id;
  }
});

function localTestDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("INBOX_TEST_POSTGRES_URL must be a PostgreSQL URL for a local test database");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const isTestDatabase = /(?:^|[_-])test(?:$|[_-])/i.test(database);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !isLocal || !isTestDatabase) {
    throw new Error("INBOX_TEST_POSTGRES_URL must use a local *_test database; remote databases are refused");
  }
  return value;
}
