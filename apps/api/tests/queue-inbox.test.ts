import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createQueueInboxService } from "../src/queue-inbox";

describe("D1 queue inbox", () => {
  it("幂等暂存并按 lease 重试，ack 后删除", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      readFileSync(new URL("../migrations/0003_queue_inbox.sql", import.meta.url), "utf8"),
    );
    let currentTime = new Date("2026-08-01T04:00:00.000Z");
    let leaseIndex = 0;
    const service = createQueueInboxService({
      database: d1(sqlite),
      now: () => currentTime,
      randomUuid: () => `00000000-0000-4000-8000-${String(++leaseIndex).padStart(12, "0")}`,
    });
    const message = {
      body: { kind: "collect-source" },
      id: "message-1",
      timestampMs: 1_754_000_000_000,
    };

    await service.stage([message, message]);
    const first = await service.pull({ batchSize: 10, visibilityTimeoutMs: 60_000 });
    expect(first.backlogCount).toBe(1);
    expect(first.messages).toEqual([
      expect.objectContaining({ attempts: 1, body: message.body, id: "message-1" }),
    ]);

    await service.settle({
      acks: [],
      retries: [{ delaySeconds: 30, leaseId: first.messages[0]!.leaseId }],
    });
    expect((await service.pull({ batchSize: 10, visibilityTimeoutMs: 60_000 })).messages).toEqual([]);

    currentTime = new Date("2026-08-01T04:00:31.000Z");
    const second = await service.pull({ batchSize: 10, visibilityTimeoutMs: 60_000 });
    expect(second.messages[0]?.attempts).toBe(2);
    await service.settle({ acks: [second.messages[0]!.leaseId], retries: [] });
    expect(await service.pull({ batchSize: 10, visibilityTimeoutMs: 60_000 })).toEqual({
      backlogCount: 0,
      messages: [],
    });
  });
});

function d1(database: DatabaseSync): D1Database {
  class Prepared {
    readonly #statement: StatementSync;
    #bindings: SQLInputValue[] = [];

    constructor(sql: string) {
      this.#statement = database.prepare(sql);
    }

    bind(...values: unknown[]): Prepared {
      this.#bindings = values as SQLInputValue[];
      return this;
    }

    async all<T>(): Promise<D1Result<T>> {
      return { results: this.#statement.all(...this.#bindings) as T[] } as D1Result<T>;
    }

    async first<T>(): Promise<T | null> {
      return (this.#statement.get(...this.#bindings) as T | undefined) ?? null;
    }

    async run<T>(): Promise<D1Result<T>> {
      const result = this.#statement.run(...this.#bindings);
      return { meta: { changes: Number(result.changes) }, results: [] } as unknown as D1Result<T>;
    }
  }

  return {
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
    prepare: (sql: string) => new Prepared(sql) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
}
