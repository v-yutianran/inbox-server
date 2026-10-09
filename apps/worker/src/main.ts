import type { Server } from "node:http";

import type { Browser } from "playwright";

import {
  connectCloudflareBrowser,
  launchHeadedBrowser,
  runBrowserBatch,
} from "./browser.js";
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
import {
  closeHealthServer,
  createWorkerWebhookHandler,
  startHealthServer,
} from "./health-server.js";
import { createJobHandler, queueBatchRequiresBrowser } from "./job-handler.js";
import { createImaArticleMirror } from "./ima-article-mirror.js";
import { createGcsObjectStore } from "./gcs-object-store.js";
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
  let runNextBatch: (() => Promise<number>) | undefined;
  let activeWebhookBatch: Promise<number> | undefined;

  try {
    const attachmentStore = config.telegramAttachmentBucket
      ? createGcsObjectStore({ bucket: config.telegramAttachmentBucket })
      : undefined;
    const webhook = config.runMode === "webhook"
      ? createWorkerWebhookHandler({
          getAvailability: () => {
            if (abortController.signal.aborted) return "stopping";
            if (state.phase !== "ready" || !runNextBatch) return "not_ready";
            return "ready";
          },
          log: workerLog,
          processBatch: async () => {
            const processBatch = runNextBatch;
            if (!processBatch) throw new Error("worker batch processor is not ready");
            const activeBatch = Promise.resolve().then(processBatch);
            activeWebhookBatch = activeBatch;
            try {
              return await activeBatch;
            } finally {
              if (activeWebhookBatch === activeBatch) activeWebhookBatch = undefined;
            }
          },
          token: required(config.workerWebhookToken, "WORKER_WEBHOOK_TOKEN"),
        })
      : undefined;
    healthServer = await startHealthServer({
      getState: () => state,
      port: config.healthPort,
      staleAfterMs: config.healthStaleAfterMs,
      ...(webhook === undefined ? {} : { webhook }),
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
    if (config.browserProvider === "local") {
      browser = await launchHeadedBrowser(
        required(config.display, "DISPLAY"),
        config.browserProxyUrl ?? outboundProxy?.url,
        config.browserLaunchTimeoutMs,
      );
      state = reduceWorkerHealthState(state, {
        at: Date.now(),
        type: "browser-ready",
      });
    } else {
      state = reduceWorkerHealthState(state, {
        at: Date.now(),
        component: "browser",
        reasonCode: "browser_provider_configured",
        state: "ready",
        type: "component-state",
      });
    }
    if (config.browserProvider === "local" && config.browserProxyUrl) {
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
      ...(config.display ? { display: config.display } : {}),
      browserProvider: config.browserProvider,
      browserProxyEnabled: config.browserProvider === "local"
        && Boolean(config.browserProxyUrl ?? outboundProxy),
      healthPort: config.healthPort,
      outboundProxyEnabled: Boolean(outboundProxy),
      processingEnabled: config.processingEnabled,
    });
    if (!config.processingEnabled) {
      await waitForAbort(abortController.signal);
    } else {
      const controlPlaneUrl = required(config.controlPlaneUrl, "CONTROL_PLANE_URL");
      const serviceToken = required(config.workerServiceToken, "WORKER_SERVICE_TOKEN");
      const controlPlane = createWorkerControlPlane(
        controlPlaneUrl,
        serviceToken,
        externalFetch,
      );
      let latestBacklogCount = 0;
      if (config.runMode === "loop") {
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
      }
      const queue = createControlPlaneQueueClient(
        {
          batchSize: config.queueBatchSize,
          controlPlaneUrl,
          serviceToken,
          visibilityTimeoutMs: config.visibilityTimeoutMs,
        },
        externalFetch,
      );
      const channels = await loadChannels(config.channelsPath);
      await controlPlane.putState("channels:safe", safeChannelSummary(channels));
      const mirror = createImaArticleMirror({
        apiKey: config.imaApiKey,
        clientId: config.imaClientId,
        enabled: config.imaMirrorEnabled,
        fetcher: externalFetch,
        knowledgeBaseName: config.imaKnowledgeBaseName,
        log: workerLog,
        stateDirectory: config.imaStateDirectory,
        ...(config.runMode === "webhook" ? { stateStore: controlPlane } : {}),
        timeoutMs: config.imaTimeoutMs,
        webHeaders: config.imaWebHeaders,
        webKnowledgeBaseId: config.imaWebKnowledgeBaseId,
      });
      const articleRepository = channels.article_archive.enabled
        ? new GitArticleRepository({
            articlesDir: channels.article_archive.articles_dir,
            askpassPath: config.githubAskpassPath,
            githubToken: required(config.githubToken, "GITHUB_TOKEN"),
            repositoryDir: channels.article_archive.repository_dir,
            repositoryUrl: required(
              config.articleRepositoryUrl,
              "ARTICLE_REPOSITORY_URL",
            ),
          })
        : undefined;
      const notify = createNotifier({
        channels,
        emailNotificationsEnabled: config.emailNotificationsEnabled,
        fetcher: externalFetch,
      });
      const createHandle = (jobBrowser: Browser | undefined) => {
        const archive = jobBrowser && articleRepository
          ? createArticleArchiver({
              browser: jobBrowser,
              channels,
              fetcher: externalFetch,
              getCredential: (name) => controlPlane.getCredential(name),
              log: workerLog,
              mirror,
              recordEvent: (event) => controlPlane.recordArticleEvent(event),
              repository: articleRepository,
              templatePath: config.articleTemplatePath,
            })
          : undefined;
        return createJobHandler({
          ...(attachmentStore ? { attachmentStore } : {}),
          ...(archive ? { archive } : {}),
          ...(jobBrowser ? { browser: jobBrowser } : {}),
          channels,
          controlPlane,
          fetcher: externalFetch,
          notify,
          stagingDir: config.stagingDir,
        });
      };
      const handle = config.browserProvider === "local" ? createHandle(browser) : undefined;
      const processNextBatch = async () => {
        const batch = await queue.pull();
        latestBacklogCount = batch.backlogCount;
        const processBatch = (jobBrowser: Browser | undefined) => processQueueBatch({
          accept: (job) => decideJobAcceptance(state, job),
          batch,
          controlPlane,
          handle: handle ?? createHandle(jobBrowser),
          log: workerLog,
          onProgress: () => {
            state = reduceWorkerHealthState(state, {
              at: Date.now(),
              type: "loop-progress",
            });
          },
          queue,
        });
        if (config.browserProvider === "cloudflare") {
          await runBrowserBatch(
            queueBatchRequiresBrowser(batch, channels),
            () => connectCloudflareBrowser(
              required(config.cloudflareAccountId, "CLOUDFLARE_ACCOUNT_ID"),
              required(config.cloudflareBrowserToken, "CLOUDFLARE_BROWSER_TOKEN"),
              config.browserConnectTimeoutMs,
            ),
            processBatch,
          );
        } else {
          await processBatch(browser);
        }
        state = reduceWorkerHealthState(state, {
          at: Date.now(),
          type: "loop-progress",
        });
        return batch.messages.length;
      };
      runNextBatch = processNextBatch;

      if (config.runMode === "webhook") {
        await waitForAbort(abortController.signal);
      } else {
        while (!abortController.signal.aborted) {
          try {
            const messageCount = await processNextBatch();
            if (messageCount === 0) {
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
    }
  } finally {
    stop();
    await heartbeatTask;
    if (healthServer) await closeHealthServer(healthServer);
    await activeWebhookBatch?.catch(() => undefined);
    await browser?.close();
    await outboundProxy?.close();
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
