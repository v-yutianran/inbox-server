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
  decideJobAcceptance,
  healthSnapshot,
  reduceWorkerHealthState,
  type WorkerHealthState,
} from "./health.js";
import { abortableDelay, runHeartbeatLoop } from "./heartbeat.js";
import { closeHealthServer, startHealthServer } from "./health-server.js";
import { createJobHandler } from "./job-handler.js";
import { createNotifier } from "./notifications.js";
import {
  createRuntimeMetrics,
  reduceRuntimeMetrics,
  runtimeMetricsSnapshot,
  sanitizeLogContext,
} from "./observability.js";
import {
  startWarpOutboundProxy,
  type WarpOutboundProxy,
} from "./outbound-proxy.js";
import { processQueueBatch } from "./queue-processor.js";
import { createWorkerControlPlane } from "./worker-control-plane.js";

async function run(): Promise<void> {
  const config = parseWorkerConfig(process.env);
  const abortController = new AbortController();
  let state: WorkerHealthState = createWorkerHealthState(Date.now(), {
    mihomoRequired: Boolean(config.browserProxyUrl),
    warpRequired: Boolean(config.warpSocksProxyUrl),
  });
  let runtimeMetrics = createRuntimeMetrics();
  const workerLog = (event: string, context: Readonly<Record<string, unknown>> = {}) => {
    runtimeMetrics = reduceRuntimeMetrics(runtimeMetrics, event);
    log(event, context);
  };
  const stop = () => {
    state = reduceWorkerHealthState(state, {
      at: Date.now(),
      type: "shutdown-started",
    });
    abortController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let browser: Browser | undefined;
  let heartbeatTask: Promise<void> | undefined;
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
    if (config.warpSocksProxyUrl) {
      state = reduceWorkerHealthState(state, {
        at: Date.now(),
        component: "warp",
        reasonCode: "socks_proxy_connected",
        state: "ready",
        type: "component-state",
      });
    }
    const externalFetch = outboundProxy?.fetcher ?? fetch;
    browser = await launchHeadedBrowser(
      config.display,
      config.browserProxyUrl ?? outboundProxy?.url,
    );
    state = reduceWorkerHealthState(state, {
      at: Date.now(),
      type: "browser-ready",
    });
    if (config.browserProxyUrl) {
      state = reduceWorkerHealthState(state, {
        at: Date.now(),
        component: "mihomo",
        reasonCode: "browser_proxy_configured",
        state: "ready",
        type: "component-state",
      });
    }
    workerLog("worker.lifecycle.ready", {
      description: "Worker 运行依赖已就绪",
      display: config.display,
      browserProxyEnabled: Boolean(config.browserProxyUrl ?? outboundProxy),
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
      let latestBacklogCount = 0;
      heartbeatTask = runHeartbeatLoop({
        controlPlane,
        details: () => ({
          backlogCount: latestBacklogCount,
          deploymentVersion: process.env.DEPLOYMENT_VERSION ?? "unknown",
          ...healthSnapshot(state),
          metrics: runtimeMetricsSnapshot(runtimeMetrics),
          processingEnabled: true,
        }),
        intervalMs: config.heartbeatIntervalMs,
        onError: (error) => {
          workerLog("worker.heartbeat.failed", { error: safeErrorMessage(error) });
        },
        signal: abortController.signal,
        workerId: config.workerId,
      });
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
            log: workerLog,
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
      while (!abortController.signal.aborted) {
        try {
          const batch = await queue.pull();
          latestBacklogCount = batch.backlogCount;
          await processQueueBatch({
            accept: (job) => decideJobAcceptance(state, job),
            batch,
            controlPlane,
            handle,
            log: workerLog,
            onProgress: () => {
              state = reduceWorkerHealthState(state, {
                at: Date.now(),
                type: "loop-progress",
              });
            },
            queue,
          });
          state = reduceWorkerHealthState(state, {
            at: Date.now(),
            type: "loop-progress",
          });
          if (batch.messages.length === 0) {
            await abortableDelay(config.queuePollIntervalMs, abortController.signal);
          }
        } catch (error: unknown) {
          state = reduceWorkerHealthState(state, {
            at: Date.now(),
            type: "loop-error",
          });
          workerLog("worker.loop.failed", {
            error: safeErrorMessage(error),
          });
          await abortableDelay(config.queuePollIntervalMs, abortController.signal);
        }
      }
    }
  } finally {
    stop();
    await heartbeatTask;
    await browser?.close();
    await outboundProxy?.close();
    if (healthServer) await closeHealthServer(healthServer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    workerLog("worker.lifecycle.stopped", { description: "Worker 已完成优雅退出" });
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function log(event: string, context: Readonly<Record<string, unknown>> = {}): void {
  console.log(JSON.stringify({
    ...sanitizeLogContext(context),
    event,
    timestamp: new Date().toISOString(),
  }));
}

run().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : "unknown error",
      event: "worker.lifecycle.failed",
      timestamp: new Date().toISOString(),
    }),
  );
  process.exitCode = 1;
});
