import type { Server } from "node:http";

import type { Browser } from "playwright";

import { launchHeadedBrowser } from "./browser.js";
import {
  createArticleArchiver,
  GitArticleRepository,
} from "./article-archive.js";
import { loadChannels, safeChannelSummary } from "./channels.js";
import { createControlPlaneQueueClient } from "./cloudflare-queue-client.js";
import { parseWorkerConfig } from "./config.js";
import {
  createWorkerHealthState,
  reduceWorkerHealthState,
  type WorkerHealthState,
} from "./health.js";
import { closeHealthServer, startHealthServer } from "./health-server.js";
import { createJobHandler } from "./job-handler.js";
import { createNotifier } from "./notifications.js";
import {
  startWarpOutboundProxy,
  type WarpOutboundProxy,
} from "./outbound-proxy.js";
import { processQueueBatch } from "./queue-processor.js";
import { createWorkerControlPlane } from "./worker-control-plane.js";

async function run(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let state: WorkerHealthState = createWorkerHealthState(Date.now());
  let browser: Browser | undefined;
  let healthServer: Server | undefined;
  let outboundProxy: WarpOutboundProxy | undefined;

  try {
    healthServer = await startHealthServer({
      getState: () => state,
      port: config.healthPort,
      staleAfterMs: config.healthStaleAfterMs,
    });
    outboundProxy = config.warpSocksProxyUrl
      ? await startWarpOutboundProxy({
          listenPort: config.outboundProxyPort,
          readyTimeoutMs: config.outboundProxyReadyTimeoutMs,
          socksProxyUrl: config.warpSocksProxyUrl,
        })
      : undefined;
    const externalFetch = outboundProxy?.fetcher ?? fetch;
    browser = await launchHeadedBrowser(config.display, outboundProxy?.url);
    state = reduceWorkerHealthState(state, {
      at: Date.now(),
      type: "browser-ready",
    });
    log("worker_ready", {
      display: config.display,
      healthPort: config.healthPort,
      outboundProxyEnabled: Boolean(outboundProxy),
      processingEnabled: config.processingEnabled,
    });
    if (!config.processingEnabled) {
      await waitForAbort(abortController.signal);
    } else {
      const controlPlaneUrl = required(config.controlPlaneUrl, "CONTROL_PLANE_URL");
      const serviceToken = required(config.workerServiceToken, "WORKER_SERVICE_TOKEN");
      const controlPlane = createWorkerControlPlane(controlPlaneUrl, serviceToken);
      const queue = createControlPlaneQueueClient({
        batchSize: config.queueBatchSize,
        controlPlaneUrl,
        serviceToken,
        visibilityTimeoutMs: config.visibilityTimeoutMs,
      });
      const channels = await loadChannels(config.channelsPath);
      await controlPlane.putState("channels:safe", safeChannelSummary(channels));
      const archive = channels.article_archive.enabled
        ? createArticleArchiver({
            browser,
            channels,
            fetcher: externalFetch,
            getCredential: (name) => controlPlane.getCredential(name),
            recordEvent: (event) => controlPlane.recordArticleEvent(event),
            repository: new GitArticleRepository({
              articlesDir: channels.article_archive.articles_dir,
              askpassPath: config.githubAskpassPath,
              githubToken: required(config.githubToken, "GITHUB_TOKEN"),
              repositoryDir: channels.article_archive.repository_dir,
              repositoryUrl: required(
                config.articleRepositoryUrl,
                "ARTICLE_REPOSITORY_URL",
              ),
            }),
            templatePath: config.articleTemplatePath,
          })
        : undefined;
      const handle = createJobHandler({
        ...(archive ? { archive } : {}),
        browser,
        channels,
        controlPlane,
        fetcher: externalFetch,
        notify: createNotifier({ channels, fetcher: externalFetch }),
        stagingDir: config.stagingDir,
      });
      let lastHeartbeatAt = 0;
      while (!abortController.signal.aborted) {
        try {
          const batch = await queue.pull();
          await processQueueBatch({
            batch,
            controlPlane,
            handle,
            log,
            onProgress: () => {
              state = reduceWorkerHealthState(state, {
                at: Date.now(),
                type: "loop-progress",
              });
            },
            queue,
          });
          const currentTime = Date.now();
          state = reduceWorkerHealthState(state, {
            at: currentTime,
            type: "loop-progress",
          });
          if (currentTime - lastHeartbeatAt >= config.heartbeatIntervalMs) {
            await controlPlane.heartbeat(config.workerId, {
              backlogCount: batch.backlogCount,
              browserReady: true,
              processingEnabled: true,
            });
            lastHeartbeatAt = currentTime;
          }
          if (batch.messages.length === 0) {
            await abortableDelay(config.queuePollIntervalMs, abortController.signal);
          }
        } catch (error: unknown) {
          state = reduceWorkerHealthState(state, {
            at: Date.now(),
            type: "loop-error",
          });
          log("worker_loop_error", {
            error: safeErrorMessage(error),
          });
          await abortableDelay(config.queuePollIntervalMs, abortController.signal);
        }
      }
    }
  } finally {
    state = reduceWorkerHealthState(state, {
      at: Date.now(),
      type: "shutdown-started",
    });
    await browser?.close();
    await outboundProxy?.close();
    if (healthServer) await closeHealthServer(healthServer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    log("worker_stopped");
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return message
    .replace(/((?:authorization|cookie|password|secret|token)\s*[=:]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .slice(0, 500);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
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
