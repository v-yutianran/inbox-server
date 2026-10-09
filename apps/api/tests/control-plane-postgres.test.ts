import type { QueueJob } from "@inbox/domain";
import { describe, expect, it } from "vitest";

import { createPostgresControlPlaneCommandService } from "../src/control-plane-postgres";

const encryptionKey = Buffer.alloc(32, 9).toString("base64");
const now = () => new Date("2030-01-01T00:00:00.000Z");

const articleJob: QueueJob = {
  createdAt: "2030-01-01T00:00:00.000Z",
  dedupeKey: "dispatch:article:synthetic",
  jobId: "657cb0ad-169b-4cce-92c1-000000000001",
  kind: "dispatch-item",
  payload: {
    itemKind: "article",
    requestedAt: "2030-01-01T00:00:00.000Z",
    url: "https://example.invalid/synthetic",
  },
  schemaVersion: 1,
};

describe("PostgreSQL control-plane commands", () => {
  it("claims a new article job and stores its encrypted recovery envelope atomically", async () => {
    const pool = scriptedPool(async (_id, sql) =>
      sql.includes("INSERT INTO inbox_server.worker_jobs")
        ? { rows: [{ attempts: 1 }] }
        : { rows: [] },
    );
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await expect(service.claimJob(articleJob)).resolves.toEqual({ attempts: 1, state: "claimed" });

    expect(pool.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO inbox_server.worker_jobs"),
      expect.stringContaining("INSERT INTO inbox_server.worker_job_envelopes"),
      "COMMIT",
    ]);
    const envelope = pool.calls[2]?.values?.[4];
    expect(envelope).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(envelope as Uint8Array).toString()).not.toContain("example.invalid");
  });

  it("rolls back the worker claim when article-envelope encryption storage fails", async () => {
    const pool = scriptedPool(async (_id, sql) => {
      if (sql.includes("INSERT INTO inbox_server.worker_jobs")) return { rows: [{ attempts: 1 }] };
      if (sql.includes("INSERT INTO inbox_server.worker_job_envelopes")) {
        throw new Error("synthetic envelope write failure");
      }
      return { rows: [] };
    });
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await expect(service.claimJob(articleJob)).rejects.toThrow("synthetic envelope write failure");
    expect(pool.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("locks a conflicting job row before returning busy", async () => {
    const pool = scriptedPool(async (_id, sql) => {
      if (sql.includes("INSERT INTO inbox_server.worker_jobs")) return { rows: [] };
      if (sql.includes("SELECT attempts, created_at")) {
        return {
          rows: [{
            attempts: "1",
            created_at: articleJob.createdAt,
            dedupe_key: articleJob.dedupeKey,
            deferred_reason: null,
            deferred_until: null,
            failure_attempts: "0",
            item_kind: "article",
            job_id: articleJob.jobId,
            kind: articleJob.kind,
            status: "processing",
            updated_at: now().toISOString(),
          }],
        };
      }
      return { rows: [] };
    });
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await expect(service.claimJob(articleJob)).resolves.toEqual({ state: "busy" });
    const lockedRead = pool.calls.find(({ sql }) => sql.includes("SELECT attempts, created_at"));
    expect(lockedRead?.sql).toContain("FOR UPDATE");
    expect(pool.calls.some(({ sql }) => sql.includes("worker_job_envelopes"))).toBe(false);
    expect(pool.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("finishes jobs transactionally and creates a dead letter with its envelope", async () => {
    const pool = scriptedPool(async (_id, sql) => {
      if (sql.includes("SELECT attempts, created_at")) {
        return {
          rows: [{
            attempts: "3",
            created_at: articleJob.createdAt,
            dedupe_key: articleJob.dedupeKey,
            deferred_reason: null,
            deferred_until: null,
            failure_attempts: "2",
            item_kind: "article",
            job_id: articleJob.jobId,
            kind: articleJob.kind,
            status: "failed",
            updated_at: now().toISOString(),
          }],
        };
      }
      if (sql.includes("SELECT payload_digest")) return { rows: [{ payload_digest: "digest" }] };
      return { rows: [] };
    });
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await expect(service.finishJob(articleJob.jobId, {
      errorClass: "retryable",
      errorMessage: "synthetic failure",
      status: "failed",
    })).resolves.toEqual({ settlement: "ack" });

    const statements = pool.calls.map(({ sql }) => sql);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("FROM inbox_server.worker_jobs");
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements.some((sql) => sql.includes("INSERT INTO inbox_server.worker_dead_letters")))
      .toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE inbox_server.worker_job_envelopes")))
      .toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("keeps deferred jobs outside the failure budget and delays retry", async () => {
    const pool = scriptedPool(async (_id, sql) => {
      if (sql.includes("FROM inbox_server.worker_jobs")) {
        return {
          rows: [{
            attempts: "1",
            created_at: articleJob.createdAt,
            dedupe_key: articleJob.dedupeKey,
            deferred_reason: null,
            deferred_until: null,
            failure_attempts: "0",
            item_kind: "article",
            job_id: articleJob.jobId,
            kind: articleJob.kind,
            status: "processing",
            updated_at: now().toISOString(),
          }],
        };
      }
      return { rows: [] };
    });
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await expect(service.finishJob(articleJob.jobId, {
      reason: "rate_limit",
      retryAt: "2030-01-01T00:10:00.000Z",
      status: "deferred",
    })).resolves.toEqual({ delaySeconds: 300, settlement: "retry" });
    expect(pool.calls.some(({ sql }) => sql.includes("SET status = 'deferred'"))).toBe(true);
    expect(pool.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("records retryable failures before dead-lettering", async () => {
    const pool = scriptedPool(async (_id, sql) => {
      if (sql.includes("FROM inbox_server.worker_jobs")) {
        return {
          rows: [{
            attempts: "1",
            created_at: articleJob.createdAt,
            dedupe_key: articleJob.dedupeKey,
            deferred_reason: null,
            deferred_until: null,
            failure_attempts: "0",
            item_kind: "article",
            job_id: articleJob.jobId,
            kind: articleJob.kind,
            status: "processing",
            updated_at: now().toISOString(),
          }],
        };
      }
      return { rows: [] };
    });
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await expect(service.finishJob(articleJob.jobId, {
      errorClass: "retryable",
      errorMessage: "transient",
      status: "failed",
    })).resolves.toEqual({ delaySeconds: 30, settlement: "retry" });
    expect(pool.calls.some(({ sql }) => sql.includes("worker_dead_letters"))).toBe(false);
    expect(pool.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("updates collect sync-job completion on the same PostgreSQL transaction", async () => {
    const job: QueueJob = {
      createdAt: articleJob.createdAt,
      dedupeKey: "collect:telegram:run-synthetic",
      jobId: "657cb0ad-169b-4cce-92c1-000000000002",
      kind: "collect-source",
      payload: { shadow: false, source: "telegram", triggeredBy: "manual" },
      schemaVersion: 1,
    };
    const pool = scriptedPool(async (_id, sql) => {
      if (sql.includes("FROM inbox_server.worker_jobs")) {
        return {
          rows: [{
            attempts: "1",
            created_at: job.createdAt,
            dedupe_key: job.dedupeKey,
            deferred_reason: null,
            deferred_until: null,
            failure_attempts: "0",
            item_kind: null,
            job_id: job.jobId,
            kind: job.kind,
            status: "processing",
            updated_at: now().toISOString(),
          }],
        };
      }
      if (sql.includes("FROM inbox_server.sync_jobs")) {
        return { rows: [{ stats: JSON.stringify({ queued: { telegram: { count: 1 } } }) }] };
      }
      return { rows: [] };
    });
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await service.finishJob(job.jobId, { status: "done", summary: { collected: 3, published: 2 } });

    const syncRead = pool.calls.find(({ sql }) => sql.includes("FROM inbox_server.sync_jobs"));
    const syncWrite = pool.calls.find(({ sql }) => sql.includes("UPDATE inbox_server.sync_jobs"));
    expect(syncRead?.sql).toContain("FOR UPDATE");
    expect(syncWrite?.values?.[1]).toBe("done");
    expect(JSON.parse(String(syncWrite?.values?.[0]))).toEqual({
      queued: { telegram: { count: 1 } },
      telegram: {
        collected: 3,
        enqueued: { total: 2 },
        published: 2,
        status: "done",
      },
    });
    expect(pool.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rolls back every command when a write fails", async () => {
    const pool = scriptedPool(async (_id, sql) => {
      if (sql.includes("INSERT INTO inbox_server.worker_jobs")) throw new Error("synthetic failure");
      return { rows: [] };
    });
    const service = createPostgresControlPlaneCommandService({ pool, encryptionKey, now });

    await expect(service.claimJob(articleJob)).rejects.toThrow("synthetic failure");
    expect(pool.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO inbox_server.worker_jobs"),
      "ROLLBACK",
    ]);
  });
});

interface RecordedCall {
  readonly connectionId: number;
  readonly sql: string;
  readonly values?: readonly unknown[];
}

function scriptedPool(
  respond: (connectionId: number, sql: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
) {
  const calls: RecordedCall[] = [];
  let connections = 0;
  return {
    calls,
    async connect() {
      const connectionId = ++connections;
      return {
        async query<Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<{ rows: readonly Row[] }> {
          calls.push(values === undefined ? { connectionId, sql } : { connectionId, sql, values });
          return await respond(connectionId, sql) as { rows: Row[] };
        },
        release() {},
      };
    },
  };
}
