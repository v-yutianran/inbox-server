import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { legacySnapshotSchema } from "../src/legacy-migration.js";

const { values } = parseArgs({
  options: {
    "api-url": { type: "string" },
    "dry-run": { default: false, type: "boolean" },
    input: { type: "string" },
  },
  strict: true,
});

if (!values.input) throw new Error("--input is required");
const snapshot = legacySnapshotSchema.parse(
  JSON.parse(await readFile(values.input, "utf8")) as unknown,
);
const counts = {
  postgres: Object.fromEntries(
    Object.entries(snapshot.postgres).map(([name, rows]) => [name, rows.length]),
  ),
  redis: Object.fromEntries(
    Object.entries(snapshot.redis).map(([name, rows]) => [name, rows.length]),
  ),
};

if (values["dry-run"]) {
  console.log(JSON.stringify({ counts, status: "dry-run" }));
} else {
  const apiUrl = values["api-url"] ?? process.env.INBOX_API_URL;
  const token = process.env.WORKER_SERVICE_TOKEN;
  if (!apiUrl || !token) throw new Error("--api-url/INBOX_API_URL and WORKER_SERVICE_TOKEN are required");
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/internal/migration/import`, {
    body: JSON.stringify(snapshot),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`legacy state import failed: ${response.status}`);
  console.log(JSON.stringify({ report: await response.json(), status: "imported" }));
}
