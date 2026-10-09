import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresControlPlaneEffectsService } from "../src/control-plane-postgres-effects.js";
import { createHyperdrivePostgresPool } from "../src/postgres-connection.js";
import type { PostgresPool } from "../src/queue-inbox-postgres.js";

const rawDatabaseUrl = process.env.INBOX_TEST_POSTGRES_URL;
const databaseUrl = rawDatabaseUrl ? localTestDatabaseUrl(rawDatabaseUrl) : undefined;
const integration = databaseUrl ? describe : describe.skip;

describe("PostgreSQL effect settlement", () => {
  it("bounds stored effect errors to 500 characters", async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const pool: PostgresPool = {
      async connect() {
        return {
          async query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
            calls.push(values === undefined ? { sql } : { sql, values });
            return { rows: [] as Row[] };
          },
          release() {},
        };
      },
    };
    const service = createPostgresControlPlaneEffectsService({ pool });

    await service.finishEffect("effect-test", {
      errorClass: "retryable", errorMessage: "x".repeat(600), status: "failed",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("UPDATE inbox_server.worker_effects");
    expect(calls[0]?.values?.[2]).toHaveLength(500);
  });
});

integration("PostgreSQL control-plane effect concurrency", () => {
  let setupClient: Client | undefined;
  let schemaReady = false;
  let service: ReturnType<typeof createPostgresControlPlaneEffectsService>;
  const effectKeys: string[] = [];
  const rateScopes: string[] = [];
  const batchScopes: string[] = [];

  beforeAll(async () => {
    setupClient = new Client({ connectionString: databaseUrl });
    await setupClient.connect();
    const version = await setupClient.query<{ version_num: number }>(
      "SELECT current_setting('server_version_num')::int AS version_num",
    );
    if (version.rows[0]?.version_num !== 170006) {
      throw new Error("INBOX_TEST_POSTGRES_URL must point to PostgreSQL 17.6");
    }
    await setupClient.query(readFileSync(
      new URL("../postgres-migrations/0001_initial.sql", import.meta.url), "utf8",
    ));
    schemaReady = true;
    service = createPostgresControlPlaneEffectsService({
      pool: createHyperdrivePostgresPool({ connectionString: databaseUrl! }),
    });
  });

  afterAll(async () => {
    if (!setupClient) return;
    try {
      if (schemaReady) {
        await setupClient.query("BEGIN");
        try {
          await setupClient.query(
            "DELETE FROM inbox_server.worker_effects WHERE effect_key = ANY($1::text[])",
            [effectKeys],
          );
          await setupClient.query(
            "DELETE FROM inbox_server.worker_rate_limits WHERE scope = ANY($1::text[])",
            [rateScopes],
          );
          await setupClient.query(
            "DELETE FROM inbox_server.worker_rate_limit_batches WHERE scope = ANY($1::text[])",
            [batchScopes],
          );
          await setupClient.query("COMMIT");
        } catch (error) {
          await setupClient.query("ROLLBACK");
          throw error;
        }
        const remaining = await setupClient.query<{ effects: string; rates: string; batches: string }>(
          `SELECT
             (SELECT COUNT(*)::text FROM inbox_server.worker_effects WHERE effect_key = ANY($1::text[])) AS effects,
             (SELECT COUNT(*)::text FROM inbox_server.worker_rate_limits WHERE scope = ANY($2::text[])) AS rates,
             (SELECT COUNT(*)::text FROM inbox_server.worker_rate_limit_batches WHERE scope = ANY($3::text[])) AS batches`,
          [effectKeys, rateScopes, batchScopes],
        );
        expect(remaining.rows[0]).toEqual({ effects: "0", rates: "0", batches: "0" });
      }
    } finally {
      await setupClient.end();
    }
  });

  it("allows only one concurrent claim for a new effect key", async () => {
    const effectKey = `integration:${crypto.randomUUID()}`;
    effectKeys.push(effectKey);
    const claims = await Promise.all([
      service.claimEffect({ destination: "test", effectKey, jobId: crypto.randomUUID() }),
      service.claimEffect({ destination: "test", effectKey, jobId: crypto.randomUUID() }),
    ]);
    expect(claims.map((claim) => claim.state).sort()).toEqual(["busy", "claimed"]);
    expect(claims.find((claim) => claim.state === "claimed")).toMatchObject({ attempts: 1 });
    const stored = await setupClient!.query<{ attempts: string; count: string }>(
      `SELECT attempts::text AS attempts, COUNT(*) OVER()::text AS count
       FROM inbox_server.worker_effects WHERE effect_key = $1`,
      [effectKey],
    );
    expect(stored.rows).toEqual([{ attempts: "1", count: "1" }]);
  });

  it("does not exceed a single rate-limit bucket under two concurrent requests", async () => {
    const scope = `integration:${crypto.randomUUID()}`;
    rateScopes.push(scope);
    const input = { bucketKey: "one", limit: 1, scope, windowSeconds: 600 };
    const results = await Promise.all([service.consumeRateLimit(input), service.consumeRateLimit(input)]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    const stored = await setupClient!.query<{ count: string }>(
      "SELECT count::text AS count FROM inbox_server.worker_rate_limits WHERE scope = $1",
      [scope],
    );
    expect(stored.rows).toEqual([{ count: "1" }]);
  });

  it("commits a concurrent multi-bucket rate-limit decision atomically", async () => {
    const suffix = crypto.randomUUID();
    const inputs = [
      { bucketKey: "window", limit: 1, scope: `integration:${suffix}:window`, windowSeconds: 600 },
      { bucketKey: "daily", limit: 1, scope: `integration:${suffix}:daily`, windowSeconds: 600 },
    ];
    const batchScope = inputs.map((input) => input.scope).sort().join("|");
    batchScopes.push(batchScope);
    const results = await Promise.all([
      service.consumeRateLimits(inputs),
      service.consumeRateLimits(inputs),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    const stored = await setupClient!.query<{ state: string }>(
      "SELECT state FROM inbox_server.worker_rate_limit_batches WHERE scope = $1",
      [batchScope],
    );
    expect(JSON.parse(stored.rows[0]!.state)).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucketKey: "window", count: 1 }),
      expect.objectContaining({ bucketKey: "daily", count: 1 }),
    ]));
  });
});

function localTestDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("INBOX_TEST_POSTGRES_URL must be a PostgreSQL URL for inbox_control_test");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || parsed.hostname !== "127.0.0.1" ||
      parsed.port !== "55448" || database !== "inbox_control_test" || !database.endsWith("_test")) {
    throw new Error("INBOX_TEST_POSTGRES_URL must use 127.0.0.1:55448/inbox_control_test; remote databases are refused");
  }
  return value;
}
