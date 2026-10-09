import { beforeEach, describe, expect, it, vi } from "vitest";

const pgMock = vi.hoisted(() => ({ clients: [] as unknown[] }));

vi.mock("pg", () => ({
  Client: class {
    readonly options: unknown;
    connected = false;
    ended = false;
    queries: Array<{ sql: string; values?: unknown[] }> = [];

    constructor(options: unknown) {
      this.options = options;
      pgMock.clients.push(this);
    }

    async connect() {
      this.connected = true;
    }

    async query<Row>(sql: string, values?: unknown[]) {
      this.queries.push(values === undefined ? { sql } : { sql, values });
      return { rows: [] as Row[] };
    }

    async end() {
      this.ended = true;
    }
  },
  types: {
    getTypeParser(oid: number, format?: string) {
      return (value: string) => `${oid}:${format ?? "text"}:${value}`;
    },
  },
}));

import { createHyperdrivePostgresPool } from "../src/postgres-connection";

describe("Hyperdrive PostgreSQL connection", () => {
  beforeEach(() => pgMock.clients.splice(0));

  it("creates and connects a pg Client per pool connection, then ends it on release", async () => {
    const pool = createHyperdrivePostgresPool({ connectionString: "hyperdrive-test" });

    const first = await pool.connect();
    const second = await pool.connect();

    expect(pgMock.clients).toHaveLength(2);
    const clients = pgMock.clients as FakeClient[];
    expect(clients.map(({ connected }) => connected)).toEqual([true, true]);
    expect(clients.map(({ options }) => options.connectionString)).toEqual([
      "hyperdrive-test",
      "hyperdrive-test",
    ]);
    await first.query("SELECT $1", [42]);
    expect(clients[0]?.queries).toEqual([{ sql: "SELECT $1", values: [42] }]);
    await first.release();
    await second.release();
    expect(clients.map(({ ended }) => ended)).toEqual([true, true]);
  });

  it("parses int8 only when exactly representable as a JavaScript number", async () => {
    const pool = createHyperdrivePostgresPool({ connectionString: "hyperdrive-test" });
    const connection = await pool.connect();
    const client = pgMock.clients[0]! as FakeClient;
    const { options } = client;
    const parseInt8 = options.types.getTypeParser(20, "text");

    expect(parseInt8("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseInt8("-9007199254740991")).toBe(Number.MIN_SAFE_INTEGER);
    expect(() => parseInt8("9007199254740992")).toThrow(/safe integer range/);
    expect(() => parseInt8("-9007199254740992")).toThrow(/safe integer range/);
    expect(options.types.getTypeParser(23, "text")("7")).toBe("23:text:7");
    await connection.release();
  });
});

interface FakeClient {
  readonly options: {
    readonly connectionString: string;
    readonly types: {
      getTypeParser(oid: number, format?: string): (value: string) => unknown;
    };
  };
  readonly connected: boolean;
  readonly ended: boolean;
  readonly queries: ReadonlyArray<{
    readonly sql: string;
    readonly values?: readonly unknown[];
  }>;
}
