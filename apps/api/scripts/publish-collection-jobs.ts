import { parseArgs } from "node:util";

import { sourceNames, type SourceName } from "@inbox/domain";

import { buildCollectionJobs } from "../src/operations.js";

const { values } = parseArgs({
  options: {
    "api-url": { type: "string" },
    "dry-run": { default: false, type: "boolean" },
    mode: { default: "shadow", type: "string" },
    "run-id": { type: "string" },
    sources: { default: "all", type: "string" },
  },
  strict: true,
});

if (values.mode !== "shadow" && values.mode !== "production") {
  throw new Error("--mode must be shadow or production");
}
const selectedSources = parseSources(values.sources);
const runId = values["run-id"] ?? crypto.randomUUID();
const jobs = buildCollectionJobs({
  createdAt: new Date().toISOString(),
  randomUuid: () => crypto.randomUUID(),
  runId,
  shadow: values.mode === "shadow",
  sources: selectedSources,
  triggeredBy: values.mode === "shadow" ? "shadow" : "manual",
});

if (values["dry-run"]) {
  console.log(
    JSON.stringify({ count: jobs.length, mode: values.mode, sources: selectedSources, status: "dry-run" }),
  );
} else {
  const apiUrl = values["api-url"] ?? process.env.INBOX_API_URL;
  const token = process.env.WORKER_SERVICE_TOKEN;
  if (!apiUrl || !token) throw new Error("--api-url/INBOX_API_URL and WORKER_SERVICE_TOKEN are required");
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/internal/jobs/publish`, {
    body: JSON.stringify({ jobs }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`collection job publish failed: ${response.status}`);
  console.log(
    JSON.stringify({ count: jobs.length, mode: values.mode, sources: selectedSources, status: "published" }),
  );
}

function parseSources(value: string): readonly SourceName[] {
  if (value === "all") return sourceNames;
  const requested = value.split(",").map((source) => source.trim()).filter(Boolean);
  if (requested.length === 0 || requested.some((source) => !sourceNames.includes(source as SourceName))) {
    throw new Error("--sources contains an unsupported source");
  }
  return requested as SourceName[];
}
