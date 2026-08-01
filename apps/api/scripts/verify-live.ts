import { operationsOverviewSchema } from "../src/operations.js";

const apiKey = process.env.INBOX_ADMIN_API_KEY?.trim();
if (!apiKey) throw new Error("INBOX_ADMIN_API_KEY is required");

const apiBaseUrl = process.env.API_BASE_URL ??
  "https://inbox-server-api.yutianran666.workers.dev";
const consoleOrigin = process.env.CONSOLE_ORIGIN ??
  "https://feat-cloudflare-console-serv.inbox-server-console.pages.dev";

const healthResponse = await fetch(new URL("/healthz", apiBaseUrl));
const deniedResponse = await fetch(new URL("/api/operations/overview", apiBaseUrl), {
  headers: { "X-API-Key": "invalid-live-verification-key" },
});
const overviewResponse = await fetch(new URL("/api/operations/overview", apiBaseUrl), {
  headers: { Origin: consoleOrigin, "X-API-Key": apiKey },
});
const syncResponse = await fetch(new URL("/sync", apiBaseUrl), {
  headers: { "X-API-Key": apiKey },
  method: "POST",
});

if (healthResponse.status !== 200) throw new Error(`healthz failed: ${healthResponse.status}`);
if (deniedResponse.status !== 401) throw new Error(`invalid key was not rejected: ${deniedResponse.status}`);
if (overviewResponse.status !== 200) throw new Error(`overview failed: ${overviewResponse.status}`);
if (syncResponse.status !== 503) throw new Error(`sync safety gate failed: ${syncResponse.status}`);
if (overviewResponse.headers.get("Access-Control-Allow-Origin") !== consoleOrigin) {
  throw new Error("console CORS origin was not accepted");
}

const overview = operationsOverviewSchema.parse(await overviewResponse.json());
const syncBody = await syncResponse.json() as { readonly detail?: string };
if (syncBody.detail !== "sync queue consumer unavailable") {
  throw new Error("sync safety response was unexpected");
}

console.log(
  JSON.stringify({
    articleEvents: overview.article_events.length,
    cors: "accepted",
    destinations: Object.keys(overview.channels.destinations).length,
    health: "ok",
    invalidKey: "rejected",
    overview: "ok",
    schedulerEnabled: overview.scheduler.enabled,
    sources: Object.keys(overview.channels.sources).length,
    syncGate: "closed",
    syncJobs: overview.sync_jobs.length,
    workerOnline: overview.worker.online,
  }),
);
