import { Client, types, type CustomTypesConfig } from "pg";

import type { PostgresPool } from "./queue-inbox-postgres.js";

const INT8_OID = 20;

const safeIntegerTypes: CustomTypesConfig = {
  getTypeParser(oid, format) {
    if (oid === INT8_OID && format !== "binary") return parseSafeInt8;
    return types.getTypeParser(oid, format);
  },
};

export function createHyperdrivePostgresPool(binding: {
  readonly connectionString: string;
}): PostgresPool {
  return {
    async connect() {
      const client = new Client({
        connectionString: binding.connectionString,
        types: safeIntegerTypes,
      });
      await client.connect();
      return {
        query: <Row extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ) => client.query<Row>(sql, values),
        release: () => client.end(),
      };
    },
  };
}

function parseSafeInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError("PostgreSQL int8 exceeds JavaScript safe integer range");
  }
  return parsed;
}
