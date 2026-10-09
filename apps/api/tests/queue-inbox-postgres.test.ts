import { describe, expect, it } from "vitest";

import { createQueueInboxPostgresService } from "../src/queue-inbox-postgres";

describe("PostgreSQL queue inbox", () => {
  it("并发 pull 用 SKIP LOCKED 在独立事务中领取消息", async () => {
    const pool = scriptedPool(async (connectionId, sql) => {
      if (sql.includes("SELECT message_id, attempts, body, timestamp_ms")) {
        return {
          rows: [{
            attempts: 0,
            body: JSON.stringify({ connectionId }),
            message_id: `message-${connectionId}`,
            timestamp_ms: "1754000000000",
          }],
        };
      }
      if (sql.includes("SET status = 'leased'")) {
        return {
          rows: [{
            attempts: 1,
            body: JSON.stringify({ connectionId }),
            message_id: `message-${connectionId}`,
            timestamp_ms: "1754000000000",
          }],
        };
      }
      if (sql.includes("SELECT COUNT(*)")) return { rows: [{ count: "2" }] };
      return { rows: [] };
    });
    let leaseId = 0;
    const service = createQueueInboxPostgresService({
      pool,
      now: () => new Date("2026-08-01T04:00:00.000Z"),
      randomUuid: () => `lease-${++leaseId}`,
    });

    const [left, right] = await Promise.all([
      service.pull({ batchSize: 1, visibilityTimeoutMs: 60_000 }),
      service.pull({ batchSize: 1, visibilityTimeoutMs: 60_000 }),
    ]);

    expect(left.messages[0]?.id).not.toBe(right.messages[0]?.id);
    expect(left.messages[0]?.leaseId).not.toBe(right.messages[0]?.leaseId);
    expect(left.messages[0]?.attempts).toBe(1);
    const claims = pool.calls.filter(({ sql }) => sql.includes("FOR UPDATE SKIP LOCKED"));
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map(({ connectionId }) => connectionId)).size).toBe(2);
    expect(claims.every(({ sql }) => sql.includes("FROM inbox_server.worker_inbox"))).toBe(true);
    expect(pool.calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(2);
  });

  it("stage 用稳定 message_id 冲突忽略并保留 JSON 字符串", async () => {
    const pool = scriptedPool(async () => ({ rows: [] }));
    const service = createQueueInboxPostgresService({
      pool,
      now: () => new Date("2026-08-01T04:00:00.000Z"),
    });
    const message = {
      body: { kind: "collect-source" },
      id: "message-1",
      timestampMs: 1_754_000_000_000,
    };

    await service.stage([message, message]);

    const inserts = pool.calls.filter(({ sql }) => sql.includes("INSERT INTO"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.sql).toContain("INSERT INTO inbox_server.worker_inbox");
    expect(inserts[0]?.sql).toContain("ON CONFLICT (message_id) DO NOTHING");
    expect(inserts[0]?.values?.slice(0, 2)).toEqual([
      "message-1",
      JSON.stringify(message.body),
    ]);
  });

  it("write failure rolls the transaction back and releases the client", async () => {
    const pool = scriptedPool(async (_connectionId, sql) => {
      if (sql.includes("INSERT INTO inbox_server.worker_inbox")) throw new Error("write failed");
      return { rows: [] };
    });
    const service = createQueueInboxPostgresService({ pool });

    await expect(service.stage([{
      body: { kind: "collect-source" },
      id: "message-1",
      timestampMs: 1_754_000_000_000,
    }])).rejects.toThrow("write failed");

    expect(pool.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO inbox_server.worker_inbox"),
      "ROLLBACK",
    ]);
    expect(pool.released).toBe(1);
  });

  it("waits for async connection closure after commit and rollback", async () => {
    for (const outcome of ["COMMIT", "ROLLBACK"] as const) {
      const closeStarted = deferred<void>();
      const allowClose = deferred<void>();
      const pool = scriptedPool(
        async (_connectionId, sql) => {
          if (outcome === "ROLLBACK" && sql.includes("INSERT INTO inbox_server.worker_inbox")) {
            throw new Error("write failed");
          }
          return { rows: [] };
        },
        async () => {
          closeStarted.resolve(undefined);
          await allowClose.promise;
        },
      );
      const service = createQueueInboxPostgresService({ pool });
      let settled = false;
      const operation = service.stage([{
        body: { kind: "collect-source" },
        id: "message-1",
        timestampMs: 1_754_000_000_000,
      }]).then(
        () => undefined,
        (error: unknown) => error,
      ).finally(() => {
        settled = true;
      });

      await closeStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(pool.events.indexOf(outcome)).toBeLessThan(pool.events.indexOf("release:start"));
      allowClose.resolve(undefined);
      const error = await operation;
      expect(settled).toBe(true);
      expect(pool.events.at(-1)).toBe("release:done");
      if (outcome === "ROLLBACK") expect(error).toBeInstanceOf(Error);
      else expect(error).toBeUndefined();
    }
  });

  it("settles acknowledgements and retries inside one transaction", async () => {
    const pool = scriptedPool(async () => ({ rows: [] }));
    const service = createQueueInboxPostgresService({
      pool,
      now: () => new Date("2026-08-01T04:00:00.000Z"),
    });

    await service.settle({
      acks: ["lease-ack"],
      retries: [{ delaySeconds: 30, leaseId: "lease-retry" }],
    });

    expect(pool.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("DELETE FROM inbox_server.worker_inbox"),
      expect.stringContaining("SET status = 'queued'"),
      "COMMIT",
    ]);
    expect(new Set(pool.calls.map(({ connectionId }) => connectionId)).size).toBe(1);
  });
});

interface RecordedCall {
  readonly connectionId: number;
  readonly sql: string;
  readonly values?: readonly unknown[];
}

function scriptedPool(
  respond: (connectionId: number, sql: string) => Promise<{ rows: unknown[] }> | { rows: unknown[] },
  close: () => Promise<void> | void = () => {},
) {
  const calls: RecordedCall[] = [];
  const events: string[] = [];
  let connections = 0;
  let released = 0;

  return {
    calls,
    events,
    get released() {
      return released;
    },
    async connect() {
      const connectionId = ++connections;
      return {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
          calls.push(values === undefined ? { connectionId, sql } : { connectionId, sql, values });
          events.push(sql);
          return await respond(connectionId, sql) as { rows: Row[] };
        },
        async release() {
          events.push("release:start");
          await close();
          released += 1;
          events.push("release:done");
        },
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// This scripted pool checks SQL and transaction shape only; it does not run PostgreSQL locking.
