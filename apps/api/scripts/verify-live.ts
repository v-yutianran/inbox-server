import { parseArgs } from "node:util";

import { operationsOverviewSchema } from "../src/operations.js";

const { values } = parseArgs({
  options: {
    "dry-run": { default: false, type: "boolean" },
    "health-url": { type: "string" },
    "interval-seconds": { default: "30", type: "string" },
    "stability-seconds": { default: "0", type: "string" },
  },
  strict: true,
});
const healthUrl = new URL(
  values["health-url"] ??
    new URL("/healthz", process.env.API_BASE_URL ??
      "https://inbox-server-api.yutianran666.workers.dev"),
);
const apiBaseUrl = new URL("/", healthUrl);
const intervalSeconds = positiveInteger(values["interval-seconds"], "--interval-seconds");
const stabilitySeconds = nonNegativeInteger(
  values["stability-seconds"],
  "--stability-seconds",
);
const targets = [
  healthUrl.href,
  new URL("/api/operations/overview", apiBaseUrl).href,
  new URL("/api/operations/health/components", apiBaseUrl).href,
  new URL("/api/operations/queue/summary", apiBaseUrl).href,
  new URL("/api/operations/metrics?windowHours=24", apiBaseUrl).href,
];

if (values["dry-run"]) {
  console.log(JSON.stringify({
    dryRun: true,
    intervalSeconds,
    stabilitySeconds,
    targets,
  }));
} else {
  const apiKey = process.env.INBOX_ADMIN_API_KEY?.trim();
  if (!apiKey) throw new Error("INBOX_ADMIN_API_KEY is required");
  const startedAt = Date.now();
  const deadline = startedAt + stabilitySeconds * 1_000;
  let samples = 0;
  let latest: Awaited<ReturnType<typeof verifyOnce>> | undefined;

  do {
    latest = await verifyOnce(apiBaseUrl, healthUrl, apiKey);
    samples += 1;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(intervalSeconds * 1_000, remainingMs));
    }
  } while (Date.now() < deadline);

  console.log(JSON.stringify({
    ...latest,
    durationSeconds: Math.floor((Date.now() - startedAt) / 1_000),
    samples,
    stability: "passed",
  }));
}

async function verifyOnce(baseUrl: URL, liveHealthUrl: URL, apiKey: string) {
  const headers = { "X-API-Key": apiKey };
  const [healthResponse, deniedResponse, overviewResponse, componentsResponse,
    queueResponse, metricsResponse] = await Promise.all([
    fetch(liveHealthUrl),
    fetch(new URL("/api/operations/overview", baseUrl), {
      headers: { "X-API-Key": "invalid-live-verification-key" },
    }),
    fetch(new URL("/api/operations/overview", baseUrl), { headers }),
    fetch(new URL("/api/operations/health/components", baseUrl), { headers }),
    fetch(new URL("/api/operations/queue/summary", baseUrl), { headers }),
    fetch(new URL("/api/operations/metrics?windowHours=24", baseUrl), { headers }),
  ]);
  assertStatus(healthResponse, 200, "healthz");
  assertStatus(deniedResponse, 401, "invalid key rejection");
  assertStatus(overviewResponse, 200, "overview");
  assertStatus(componentsResponse, 200, "health components");
  assertStatus(queueResponse, 200, "queue summary");
  assertStatus(metricsResponse, 200, "metrics");

  const overview = operationsOverviewSchema.parse(await overviewResponse.json());
  const components = await componentsResponse.json() as {
    readonly components?: ReadonlyArray<{
      readonly component?: string;
      readonly state?: string;
    }>;
  };
  const queue = await queueResponse.json() as {
    readonly categories?: { readonly executable?: number };
  };
  const metrics = await metricsResponse.json() as {
    readonly deploymentVersion?: string;
    readonly metrics?: readonly unknown[];
  };
  const states = new Map(
    (components.components ?? []).map(({ component, state }) => [component, state]),
  );
  const unready = ["api", "worker", "browser", "mihomo", "warp"]
    .map((component) => [component, states.get(component)] as const)
    .filter(([, state]) => state !== "ready")
    .map(([component, state]) => `${component}:${state ?? "missing"}`);
  if (unready.length > 0) {
    throw new Error(`health components not ready: ${unready.join(",")}`);
  }
  if (!Array.isArray(metrics.metrics) || metrics.metrics.length === 0) {
    throw new Error("operations metrics are empty");
  }

  return {
    deploymentVersion: metrics.deploymentVersion ?? "unknown",
    executable: queue.categories?.executable ?? 0,
    health: "ok",
    invalidKey: "rejected",
    metricCount: metrics.metrics.length,
    overview: "ok",
    workerOnline: overview.worker.online,
  };
}

function assertStatus(response: Response, expected: number, name: string): void {
  if (response.status !== expected) {
    throw new Error(`${name} failed: ${response.status}`);
  }
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} 必须是非负整数`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
