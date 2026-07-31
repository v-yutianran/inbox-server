import type { Server } from "node:http";

import type { Browser } from "playwright";

import { launchHeadedBrowser } from "./browser.js";
import { parseWorkerConfig } from "./config.js";
import {
  createWorkerHealthState,
  reduceWorkerHealthState,
  type WorkerHealthState,
} from "./health.js";
import { closeHealthServer, startHealthServer } from "./health-server.js";

async function run(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let state: WorkerHealthState = createWorkerHealthState(Date.now());
  let browser: Browser | undefined;
  let healthServer: Server | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  try {
    healthServer = await startHealthServer({
      getState: () => state,
      port: config.healthPort,
      staleAfterMs: config.healthStaleAfterMs,
    });
    browser = await launchHeadedBrowser(config.display);
    state = reduceWorkerHealthState(state, {
      at: Date.now(),
      type: "browser-ready",
    });
    heartbeat = setInterval(() => {
      state = reduceWorkerHealthState(state, {
        at: Date.now(),
        type: "loop-progress",
      });
    }, config.heartbeatIntervalMs);
    log("worker_ready", { display: config.display, healthPort: config.healthPort });
    await waitForAbort(abortController.signal);
  } finally {
    state = reduceWorkerHealthState(state, {
      at: Date.now(),
      type: "shutdown-started",
    });
    if (heartbeat) clearInterval(heartbeat);
    await browser?.close();
    if (healthServer) await closeHealthServer(healthServer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    log("worker_stopped");
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function log(event: string, context: Readonly<Record<string, unknown>> = {}): void {
  console.log(JSON.stringify({ ...context, event, timestamp: new Date().toISOString() }));
}

run().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "unknown error",
      event: "worker_failed",
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
