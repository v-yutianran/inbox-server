import { operationsOverviewSchema } from "../src/operations.js";

const apiKey = process.env.INBOX_ADMIN_API_KEY?.trim();
if (!apiKey) throw new Error("INBOX_ADMIN_API_KEY is required");
const workerToken = process.env.WORKER_SERVICE_TOKEN?.trim();
if (!workerToken) throw new Error("WORKER_SERVICE_TOKEN is required");

const legacyApiBaseUrl = process.env.LEGACY_API_BASE_URL ?? "http://127.0.0.1:8000";
const apiBaseUrl = process.env.API_BASE_URL ??
  "https://inbox-server-api.yutianran666.workers.dev";
const response = await fetch(new URL("/api/operations/overview", legacyApiBaseUrl), {
  headers: { "X-API-Key": apiKey },
});
if (!response.ok) throw new Error(`legacy overview request failed: ${response.status}`);

const snapshot = operationsOverviewSchema.parse(await response.json());
const uploadResponse = await fetch(new URL("/internal/operations/snapshot", apiBaseUrl), {
  body: JSON.stringify(snapshot),
  headers: {
    Authorization: `Bearer ${workerToken}`,
    "Content-Type": "application/json",
  },
  method: "PUT",
});
if (uploadResponse.status !== 204) {
  throw new Error(`operations snapshot upload failed: ${uploadResponse.status}`);
}

console.log(
  JSON.stringify({
    articleEvents: snapshot.article_events.length,
    destinations: Object.keys(snapshot.channels.destinations).length,
    sources: Object.keys(snapshot.channels.sources).length,
    status: "imported",
    syncJobs: snapshot.sync_jobs.length,
    uploadStatus: uploadResponse.status,
  }),
);
