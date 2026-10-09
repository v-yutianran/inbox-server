import { readFileSync } from "node:fs";

import { parseQueueJob, type QueueJob } from "@inbox/domain";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { encryptJson } from "../src/credential-crypto.js";
import { createPostgresControlPlaneReplayService } from "../src/control-plane-postgres-replay.js";
import { createHyperdrivePostgresPool } from "../src/postgres-connection.js";
import type { PostgresPool } from "../src/queue-inbox-postgres.js";

const encryptionKey = Buffer.alloc(32, 17).toString("base64");
const currentTime = new Date("2030-01-01T00:00:00.000Z");
const rawDatabaseUrl = process.env.INBOX_TEST_POSTGRES_URL;
const databaseUrl = rawDatabaseUrl ? localTestDatabaseUrl(rawDatabaseUrl) : undefined;
const postgresIntegration = databaseUrl ? describe : describe.skip;
const job: QueueJob = {
  createdAt: currentTime.toISOString(),
  dedupeKey: "dispatch:article:replay-synthetic",
  jobId: "657cb0ad-169b-4cce-92c1-000000000019",
  kind: "dispatch-item",
  payload: {
    itemKind: "article",
    requestedAt: currentTime.toISOString(),
    url: "https://example.invalid/replay",
  },
  schemaVersion: 1,
};

describe("PostgreSQL dead-letter replay", () => {
  it("validates a complete AES-GCM envelope in dry-run without writes", async () => {
    const pool = scriptedPool();
    const service = createPostgresControlPlaneReplayService({ pool, encryptionKey, now: () => currentTime });

    await expect(service.replayDeadLetter(job.jobId, {
      dryRun: true,
      idempotencyKey: "operation-1",
    })).resolves.toEqual({
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated",
    });
    expect(pool.calls.some(({ sql }) => isWrite(sql))).toBe(false);
  });

  it("rejects missing and tampered recovery envelopes", async () => {
    const missingPool = scriptedPool({ envelopeMissing: true });
    const missing = createPostgresControlPlaneReplayService({
      pool: missingPool,
      encryptionKey,
      now: () => currentTime,
    });
    await expect(missing.replayDeadLetter(job.jobId, {
      dryRun: true,
      idempotencyKey: "operation-1",
    })).resolves.toMatchObject({ reason: "envelope_unavailable", status: "rejected" });

    const tamperedPool = scriptedPool({ tamperCiphertext: true });
    const tampered = createPostgresControlPlaneReplayService({
      pool: tamperedPool,
      encryptionKey,
      now: () => currentTime,
    });
    await expect(tampered.replayDeadLetter(job.jobId, {
      dryRun: true,
      idempotencyKey: "operation-1",
    })).resolves.toMatchObject({ reason: "envelope_invalid", status: "rejected" });
  });

  it("rejects terminal jobs and completed effects before replay", async () => {
    const terminalJob = createPostgresControlPlaneReplayService({
      pool: scriptedPool({ jobStatus: "done" }),
      encryptionKey,
      now: () => currentTime,
    });
    await expect(terminalJob.replayDeadLetter(job.jobId, {
      dryRun: false,
      idempotencyKey: "operation-1",
    })).resolves.toMatchObject({ reason: "done_terminal", status: "rejected" });

    const terminalEffect = createPostgresControlPlaneReplayService({
      pool: scriptedPool({ terminalEffect: "uncertain" }),
      encryptionKey,
      now: () => currentTime,
    });
    await expect(terminalEffect.replayDeadLetter(job.jobId, {
      dryRun: false,
      idempotencyKey: "operation-2",
    })).resolves.toMatchObject({ reason: "uncertain_terminal", status: "rejected" });
  });

  it("reuses the same idempotency operation and rejects a key bound to another job", async () => {
    const reusedPool = scriptedPool({ operation: {
      job_id: job.jobId,
      reason: "published",
      status: "published",
    } });
    const reused = createPostgresControlPlaneReplayService({
      pool: reusedPool,
      encryptionKey,
      now: () => currentTime,
    });
    await expect(reused.replayDeadLetter(job.jobId, {
      dryRun: false,
      idempotencyKey: "operation-1",
    })).resolves.toEqual({
      published: true,
      reason: "published",
      replayable: true,
      status: "published",
    });
    expect(reusedPool.calls.some(({ sql }) => sql.includes("INSERT INTO inbox_server.worker_inbox"))).toBe(false);

    const conflict = createPostgresControlPlaneReplayService({
      pool: scriptedPool({ operation: {
        job_id: "another-job",
        reason: "published",
        status: "published",
      } }),
      encryptionKey,
      now: () => currentTime,
    });
    await expect(conflict.replayDeadLetter(job.jobId, {
      dryRun: false,
      idempotencyKey: "operation-1",
    })).resolves.toMatchObject({ reason: "idempotency_conflict", status: "rejected" });
  });

  it("publishes the replay operation and inbox row with job and envelope updates in one transaction", async () => {
    const pool = scriptedPool();
    const service = createPostgresControlPlaneReplayService({ pool, encryptionKey, now: () => currentTime });

    await expect(service.replayDeadLetter(job.jobId, {
      dryRun: false,
      idempotencyKey: "operation-1",
    })).resolves.toEqual({
      published: true,
      reason: "published",
      replayable: true,
      status: "published",
    });
    const writes = pool.calls.filter(({ sql }) => isWrite(sql));
    expect(writes.map(({ sql }) => sql)).toEqual([
      expect.stringContaining("INSERT INTO inbox_server.worker_replay_operations"),
      expect.stringContaining("INSERT INTO inbox_server.worker_inbox"),
      expect.stringContaining("UPDATE inbox_server.worker_jobs"),
      expect.stringContaining("UPDATE inbox_server.worker_job_envelopes"),
    ]);
    expect(new Set(pool.calls.map(({ connectionId }) => connectionId)).size).toBe(1);
    expect(pool.calls.at(-1)?.sql).toBe("COMMIT");
    const inboxWrite = writes.find(({ sql }) => sql.includes("worker_inbox"));
    expect(JSON.parse(String(inboxWrite?.values?.[1]))).toEqual(job);
  });

  it("emits the published log only after the transaction commits", async () => {
    const events: string[] = [];
    const service = createPostgresControlPlaneReplayService({
      pool: scriptedPool({ events }),
      encryptionKey,
      log: (event) => events.push(event),
      now: () => currentTime,
    });

    await service.replayDeadLetter(job.jobId, { dryRun: false, idempotencyKey: "operation-1" });

    expect(events.slice(-2)).toEqual(["commit", "worker.job.replay_published"]);
  });

  it("rolls back the replay operation and inbox staging when a later update fails", async () => {
    const pool = scriptedPool({ failOn: "UPDATE inbox_server.worker_job_envelopes" });
    const service = createPostgresControlPlaneReplayService({ pool, encryptionKey, now: () => currentTime });

    await expect(service.replayDeadLetter(job.jobId, {
      dryRun: false,
      idempotencyKey: "operation-1",
    })).rejects.toThrow("synthetic write failure");
    const statements = pool.calls.map(({ sql }) => sql);
    expect(statements.some((sql) => sql.includes("INSERT INTO inbox_server.worker_replay_operations"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO inbox_server.worker_inbox"))).toBe(true);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(new Set(pool.calls.map(({ connectionId }) => connectionId)).size).toBe(1);
  });
});

interface Options {
  readonly envelopeMissing?: boolean;
  readonly events?: string[];
  readonly failOn?: string;
  readonly jobStatus?: string | null;
  readonly operation?: Record<string, unknown> | null;
  readonly tamperCiphertext?: boolean;
  readonly terminalEffect?: string | null;
}

interface RecordedCall {
  readonly connectionId: number;
  readonly sql: string;
  readonly values?: unknown[];
}

function scriptedPool(options: Options = {}): PostgresPool & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let connectionCount = 0;
  const storedJob = parseQueueJob(job);
  const messageCiphertext = encryptJson(storedJob, encryptionKey).then((ciphertext) => {
    if (options.tamperCiphertext) {
      const lastIndex = ciphertext.length - 1;
      ciphertext[lastIndex] = ciphertext[lastIndex]! ^ 1;
    }
    return ciphertext;
  });
  const payloadDigest = crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(storedJob)),
  ).then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));

  return {
    calls,
    async connect() {
      const connectionId = ++connectionCount;
      return {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ) {
          calls.push(values === undefined ? { connectionId, sql } : { connectionId, sql, values });
          if (sql === "COMMIT") options.events?.push("commit");
          if (options.failOn && sql.includes(options.failOn)) throw new Error("synthetic write failure");
          if (sql.includes("FROM inbox_server.worker_jobs")) {
            return { rows: (options.jobStatus === null ? [] : [{ status: options.jobStatus ?? "dead" }]) as unknown as Row[] };
          }
          if (sql.includes("FROM inbox_server.worker_effects")) {
            return { rows: (options.terminalEffect ? [{ status: options.terminalEffect }] : []) as unknown as Row[] };
          }
          if (sql.includes("FROM inbox_server.worker_replay_operations")) {
            return { rows: (options.operation ? [options.operation] : []) as unknown as Row[] };
          }
          if (sql.includes("INSERT INTO inbox_server.worker_replay_operations")) {
            return { rows: [{ job_id: job.jobId, reason: "published", status: "published" }] as unknown as Row[] };
          }
          if (sql.includes("FROM inbox_server.worker_dead_letters")) {
            return { rows: [{ envelope_job_id: job.jobId }] as unknown as Row[] };
          }
          if (sql.includes("FROM inbox_server.worker_job_envelopes")) {
            const [ciphertext, digest] = await Promise.all([messageCiphertext, payloadDigest]);
            return {
              rows: options.envelopeMissing
                ? []
                : [{
                    ciphertext,
                    payload_digest: digest,
                    schema_version: 1,
                    status: "dead",
                  }] as unknown as Row[],
            };
          }
          return { rows: [] as Row[] };
        },
        release() {},
      };
    },
  };
}

function isWrite(sql: string): boolean {
  return /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i.test(sql);
}

interface ReplayFixture {
  readonly idempotencyKey: string;
  readonly job: QueueJob;
  readonly messageId: string;
}

postgresIntegration("PostgreSQL dead-letter replay integration", () => {
  let setupClient: Client;
  let service: ReturnType<typeof createPostgresControlPlaneReplayService>;
  const fixtures: ReplayFixture[] = [];
  const constraints: string[] = [];

  beforeAll(async () => {
    setupClient = new Client({ connectionString: databaseUrl! });
    await setupClient.connect();
    const version = await setupClient.query<{ version_num: number }>(
      "SELECT current_setting('server_version_num')::int AS version_num",
    );
    if (version.rows[0]?.version_num !== 170006) {
      throw new Error("INBOX_TEST_POSTGRES_URL must point to the isolated PostgreSQL 17.6 test database");
    }
    await setupClient.query(readFileSync(
      new URL("../postgres-migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ));
    service = createPostgresControlPlaneReplayService({
      encryptionKey,
      pool: createHyperdrivePostgresPool({ connectionString: databaseUrl! }),
    });
  });

  afterEach(async () => {
    await removeSyntheticFixtures(setupClient, fixtures, constraints);
    for (const fixture of fixtures) await expectNoSyntheticRows(setupClient, fixture);
    fixtures.length = 0;
    constraints.length = 0;
  });

  afterAll(async () => {
    await setupClient?.end();
  });

  it("validates without writes, then atomically stages the operation and inbox row", async () => {
    const fixture = await seedDeadLetter(setupClient, "success");
    fixtures.push(fixture);

    await expect(service.replayDeadLetter(fixture.job.jobId, {
      dryRun: true,
      idempotencyKey: fixture.idempotencyKey,
    })).resolves.toEqual({
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated",
    });
    await expect(replayState(setupClient, fixture)).resolves.toEqual({
      envelope_status: "dead",
      inbox_status: null,
      job_status: "dead",
      operations: 0,
    });

    await expect(service.replayDeadLetter(fixture.job.jobId, {
      dryRun: false,
      idempotencyKey: fixture.idempotencyKey,
    })).resolves.toEqual({
      published: true,
      reason: "published",
      replayable: true,
      status: "published",
    });
    await expect(replayState(setupClient, fixture)).resolves.toEqual({
      envelope_status: "active",
      inbox_status: "queued",
      job_status: "failed",
      operations: 1,
    });
  });

  it("rolls back the operation, inbox and state updates when inbox staging violates a constraint", async () => {
    const fixture = await seedDeadLetter(setupClient, "rollback");
    fixtures.push(fixture);
    const constraint = `replay_test_${fixture.job.jobId.replaceAll("-", "")}`;
    constraints.push(constraint);
    await setupClient.query(
      `ALTER TABLE inbox_server.worker_inbox
       ADD CONSTRAINT "${constraint}" CHECK (attempts > 0) NOT VALID`,
    );

    await expect(service.replayDeadLetter(fixture.job.jobId, {
      dryRun: false,
      idempotencyKey: fixture.idempotencyKey,
    })).rejects.toMatchObject({ code: "23514" });
    await expect(replayState(setupClient, fixture)).resolves.toEqual({
      envelope_status: "dead",
      inbox_status: null,
      job_status: "dead",
      operations: 0,
    });
  });

  async function seedDeadLetter(client: Client, label: string): Promise<ReplayFixture> {
    const jobId = crypto.randomUUID();
    const job = parseQueueJob({
      createdAt: currentTime.toISOString(),
      dedupeKey: `dispatch:article:replay-${label}-${jobId}`,
      jobId,
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: currentTime.toISOString(),
        url: `https://example.invalid/${label}/${jobId}`,
      },
      schemaVersion: 1,
    });
    const idempotencyKey = `replay-${label}-${crypto.randomUUID()}`;
    const messageId = `replay-${await digest(`${job.jobId}\u0000${idempotencyKey}`)}`;
    const payloadDigest = await digest(JSON.stringify(job));
    const ciphertext = await encryptJson(job, encryptionKey);
    const timestamp = currentTime.toISOString();

    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO inbox_server.worker_jobs
         (dedupe_key, job_id, kind, item_kind, status, attempts, failure_attempts,
          created_at, updated_at, finished_at)
         VALUES ($1, $2, 'dispatch-item', 'article', 'dead', 3, 3, $3, $3, $3)`,
        [job.dedupeKey, job.jobId, timestamp],
      );
      await client.query(
        `INSERT INTO inbox_server.worker_dead_letters
         (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
          payload_digest, envelope_job_id, created_at)
         VALUES ($1, $2, 'dispatch-item', 'article', 3, 'permanent', 'synthetic failure', $3, $1, $4)`,
        [job.jobId, job.dedupeKey, payloadDigest, timestamp],
      );
      await client.query(
        `INSERT INTO inbox_server.worker_job_envelopes
         (job_id, dedupe_key, schema_version, payload_digest, ciphertext, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'dead', $6, $6)`,
        [job.jobId, job.dedupeKey, job.schemaVersion, payloadDigest, ciphertext, timestamp],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return { idempotencyKey, job, messageId };
  }

  async function replayState(client: Client, fixture: ReplayFixture): Promise<{
    readonly envelope_status: string | null;
    readonly inbox_status: string | null;
    readonly job_status: string | null;
    readonly operations: number;
  }> {
    const result = await client.query(
      `SELECT
         (SELECT status FROM inbox_server.worker_jobs WHERE job_id = $1) AS job_status,
         (SELECT status FROM inbox_server.worker_job_envelopes WHERE job_id = $1) AS envelope_status,
         (SELECT status FROM inbox_server.worker_inbox WHERE message_id = $2) AS inbox_status,
         (SELECT COUNT(*)::int FROM inbox_server.worker_replay_operations WHERE idempotency_key = $3) AS operations`,
      [fixture.job.jobId, fixture.messageId, fixture.idempotencyKey],
    );
    return result.rows[0]!;
  }
});

async function removeSyntheticFixtures(
  client: Client | undefined,
  fixtures: readonly ReplayFixture[],
  constraints: readonly string[],
): Promise<void> {
  if (!client) return;
  for (const constraint of constraints) {
    await client.query(`ALTER TABLE inbox_server.worker_inbox DROP CONSTRAINT IF EXISTS "${constraint}"`);
    const result = await client.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM pg_constraint WHERE conname = $1",
      [constraint],
    );
    expect(result.rows[0]?.count).toBe(0);
  }
  for (const fixture of fixtures) {
    await client.query("BEGIN");
    try {
      await client.query("DELETE FROM inbox_server.worker_replay_operations WHERE idempotency_key = $1", [fixture.idempotencyKey]);
      await client.query("DELETE FROM inbox_server.worker_inbox WHERE message_id = $1", [fixture.messageId]);
      await client.query("DELETE FROM inbox_server.worker_dead_letters WHERE job_id = $1", [fixture.job.jobId]);
      await client.query("DELETE FROM inbox_server.worker_job_envelopes WHERE job_id = $1", [fixture.job.jobId]);
      await client.query("DELETE FROM inbox_server.worker_jobs WHERE job_id = $1", [fixture.job.jobId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function expectNoSyntheticRows(client: Client, fixture: ReplayFixture): Promise<void> {
  const result = await client.query<{ count: number }>(
    `SELECT (
       (SELECT COUNT(*) FROM inbox_server.worker_replay_operations WHERE idempotency_key = $1) +
       (SELECT COUNT(*) FROM inbox_server.worker_inbox WHERE message_id = $2) +
       (SELECT COUNT(*) FROM inbox_server.worker_dead_letters WHERE job_id = $3) +
       (SELECT COUNT(*) FROM inbox_server.worker_job_envelopes WHERE job_id = $3) +
       (SELECT COUNT(*) FROM inbox_server.worker_jobs WHERE job_id = $3)
     )::int AS count`,
    [fixture.idempotencyKey, fixture.messageId, fixture.job.jobId],
  );
  expect(result.rows[0]?.count).toBe(0);
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function localTestDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("INBOX_TEST_POSTGRES_URL must use the isolated local PostgreSQL 17.6 test database");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !/^postgres(?:ql)?:$/.test(parsed.protocol) ||
    hostname !== "127.0.0.1" ||
    parsed.port !== "55448" ||
    database !== "inbox_control_test"
  ) {
    throw new Error("INBOX_TEST_POSTGRES_URL must use 127.0.0.1:55448/inbox_control_test; remote databases are refused");
  }
  return value;
}
