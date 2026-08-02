import type { SQLInputValue, StatementSync } from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

export function createD1TestDatabase(database: DatabaseSync): D1Database {
  class Prepared {
    readonly #statement: StatementSync;
    #bindings: SQLInputValue[] = [];

    constructor(sql: string) {
      this.#statement = database.prepare(sql);
    }

    bind(...values: unknown[]): Prepared {
      this.#bindings = values.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      ) as SQLInputValue[];
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
      return {
        meta: { changes: Number(result.changes) },
        results: [],
      } as unknown as D1Result<T>;
    }
  }

  return {
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
    prepare: (sql: string) => new Prepared(sql) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
}
