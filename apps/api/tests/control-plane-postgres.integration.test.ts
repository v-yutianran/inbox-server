import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptJson } from "../src/credential-crypto";
import { createPostgresControlPlaneCommandService } from "../src/control-plane-postgres";
import { createHyperdrivePostgresPool } from "../src/postgres-connection";

const rawDatabaseUrl = process.env.INBOX_TEST_POSTGRES_URL;
const databaseUrl = rawDatabaseUrl ? localTestDatabaseUrl(rawDatabaseUrl) : undefined;
const integration = databaseUrl ? describe : describe.skip;
const encryptionKey = Buffer.alloc(32, 11).toString("base64");

integration("PostgreSQL control-plane integration", () => {
  let setupClient: Client | undefined;
  let schemaReady = false;
  let service: ReturnType<typeof createPostgresControlPlaneCommandService>;
  const jobIds: string[] = [];

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
    service = createPostgresControlPlaneCommandService({
      encryptionKey,
      pool: createHyperdrivePostgresPool({ connectionString: databaseUrl! }),
    });
  });

  afterAll(async () => {
    if (setupClient === undefined) return;
    try {
      if (schemaReady && jobIds.length > 0) {
        await setupClient.query("BEGIN");
        await setupClient.query(
          "DELETE FROM inbox_server.worker_dead_letters WHERE job_id = ANY($1::text[])",
          [jobIds],
        );
        await setupClient.query(
          "DELETE FROM inbox_server.worker_job_envelopes WHERE job_id = ANY($1::text[])",
          [jobIds],
        );
        await setupClient.query(
          "DELETE FROM inbox_server.worker_jobs WHERE job_id = ANY($1::text[])",
          [jobIds],
        );
        await setupClient.query("COMMIT");
      }
    } catch (error) {
      await setupClient.query("ROLLBACK");
      throw error;
    } finally {
      await setupClient.end();
    }
  });

  it("concurrently claims one article, persists bytea envelope, then removes it on done", async () => {
    const job = articleJob("concurrent");
    const claims = await Promise.all([service.claimJob(job), service.claimJob(job)]);
    expect(claims.map((claim) => claim.state).sort()).toEqual(["busy", "claimed"]);
    expect(claims.find((claim) => claim.state === "claimed")).toMatchObject({
      attempts: 1,
      state: "claimed",
    });
    await expect(service.claimJob({
      ...job,
      dedupeKey: `dispatch:article:collision-${crypto.randomUUID()}`,
    })).rejects.toThrow("job claim not found after dedupe conflict");

    const stored = await setupClient!.query<{
      ciphertext: Buffer;
      payload_digest: string;
      status: string;
    }>(
      `SELECT ciphertext, payload_digest, status
       FROM inbox_server.worker_job_envelopes WHERE job_id = $1`,
      [job.jobId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(Buffer.isBuffer(stored.rows[0]?.ciphertext)).toBe(true);
    expect(stored.rows[0]?.status).toBe("active");
    expect(stored.rows[0]?.payload_digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(decryptJson(stored.rows[0]!.ciphertext, encryptionKey)).resolves.toEqual(job);

    await service.finishJob(job.jobId, { status: "done", summary: { synthetic: true } });
    const finished = await setupClient!.query<{ status: string }>(
      "SELECT status FROM inbox_server.worker_jobs WHERE job_id = $1",
      [job.jobId],
    );
    const envelopeCount = await setupClient!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM inbox_server.worker_job_envelopes WHERE job_id = $1",
      [job.jobId],
    );
    expect(finished.rows[0]?.status).toBe("done");
    expect(envelopeCount.rows[0]?.count).toBe("0");
  });

  it("rolls job and envelope state back when the dead-letter constraint rejects the insert", async () => {
    const job = articleJob("rollback");
    const constraint = `dead_letter_test_${job.jobId.replaceAll("-", "")}`;
    await service.claimJob(job);
    await setupClient!.query(
      `ALTER TABLE inbox_server.worker_dead_letters
       ADD CONSTRAINT "${constraint}" CHECK (job_id <> '${job.jobId}')`,
    );
    try {
      await setupClient!.query(
        `UPDATE inbox_server.worker_jobs
         SET status = 'processing', failure_attempts = 2 WHERE job_id = $1`,
        [job.jobId],
      );

      await expect(service.finishJob(job.jobId, {
        errorClass: "retryable",
        errorMessage: "synthetic third failure",
        status: "failed",
      })).rejects.toMatchObject({ code: "23514" });

      const persisted = await setupClient!.query<{
        failure_attempts: string;
        job_status: string;
        envelope_status: string;
        dead_letters: string;
      }>(
        `SELECT jobs.failure_attempts::text AS failure_attempts, jobs.status AS job_status,
                envelopes.status AS envelope_status,
                (SELECT COUNT(*)::text FROM inbox_server.worker_dead_letters WHERE job_id = $1)
                  AS dead_letters
         FROM inbox_server.worker_jobs AS jobs
         JOIN inbox_server.worker_job_envelopes AS envelopes USING (job_id)
         WHERE jobs.job_id = $1`,
        [job.jobId],
      );
      expect(persisted.rows).toEqual([{
        dead_letters: "0",
        envelope_status: "active",
        failure_attempts: "2",
        job_status: "processing",
      }]);
    } finally {
      await setupClient!.query(
        `ALTER TABLE inbox_server.worker_dead_letters DROP CONSTRAINT "${constraint}"`,
      );
    }
  });

  function articleJob(label: string) {
    const jobId = crypto.randomUUID();
    const dedupeKey = `dispatch:article:integration-${label}-${crypto.randomUUID()}`;
    jobIds.push(jobId);
    return {
      createdAt: new Date().toISOString(),
      dedupeKey,
      jobId,
      kind: "dispatch-item" as const,
      payload: {
        itemKind: "article" as const,
        requestedAt: new Date().toISOString(),
        url: `https://example.invalid/${label}`,
      },
      schemaVersion: 1 as const,
    };
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
