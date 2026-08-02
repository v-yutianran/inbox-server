import {
  createItemDedupeKey,
  parseQueueJob,
  type DispatchItem,
  type QueueJob,
} from "@inbox/domain";
import type { Browser } from "playwright";

import type { Channels } from "./channels.js";
import { readOptionalString } from "./channels.js";
import { collectSource, type CollectionResult, type CollectorDependencies } from "./collectors.js";
import {
  deliverCubox,
  deliverFlomo,
  deliverJianguoyun,
  type DeliveryResult,
} from "./destinations.js";
import type { CollectionNotification } from "./notifications.js";
import { generateSmartTags } from "./smart-tags.js";
import type { WorkerControlPlane } from "./worker-control-plane.js";

type JsonRecord = Readonly<Record<string, unknown>>;
type CollectFunction = (
  source: Parameters<typeof collectSource>[0],
  dependencies: CollectorDependencies,
) => Promise<CollectionResult>;
type DeliverFunction = (
  destination: string,
  item: DispatchItem,
) => Promise<DeliveryResult>;

export type JobHandlerResult =
  | { readonly outcome: "completed"; readonly summary: JsonRecord }
  | {
      readonly outcome: "deferred";
      readonly reason: "effect_busy" | "rate_limit";
      readonly retryAt: string;
    }
  | { readonly outcome: "uncertain"; readonly reason: string };

interface JobHandlerOptions {
  readonly archive?: (item: Extract<DispatchItem, { itemKind: "article" }>) => Promise<DeliveryResult>;
  readonly browser: Browser;
  readonly channels: Channels;
  readonly collect?: CollectFunction;
  readonly controlPlane: WorkerControlPlane;
  readonly deliver?: DeliverFunction;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly notify?: (summary: CollectionNotification) => Promise<void>;
  readonly randomUuid?: () => string;
  readonly stagingDir: string;
}

export function createJobHandler(
  options: JobHandlerOptions,
): (job: QueueJob) => Promise<JobHandlerResult> {
  const collect = options.collect ?? collectSource;
  const deliver = options.deliver ?? createConfiguredDeliverer(options);
  const now = options.now ?? (() => new Date());
  const randomUuid = options.randomUuid ?? (() => crypto.randomUUID());

  return async (input) => {
    const job = parseQueueJob(input);
    if (job.kind === "collect-source") {
      const result = await collect(job.payload.source, {
        browser: options.browser,
        channels: options.channels,
        controlPlane: options.controlPlane,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        stagingDir: options.stagingDir,
      });
      const dispatchJobs = await toDispatchJobs(result.items, now, randomUuid);
      if (job.payload.shadow) {
        await options.controlPlane.putState(`shadow:${job.payload.source}`, {
          count: dispatchJobs.length,
          dedupeKeys: dispatchJobs.map(({ dedupeKey }) => dedupeKey),
          observedAt: now().toISOString(),
        });
      } else {
        await options.controlPlane.publishJobs(dispatchJobs);
        for (const update of result.stateUpdates) {
          await options.controlPlane.putState(update.key, update.value);
        }
        await result.afterCommit?.();
        await notifyCollection(options, job, result.items.length, dispatchJobs.length);
      }
      if (result.loginSession) {
        const { platform, ...session } = result.loginSession;
        await options.controlPlane.putLoginSession(platform, session);
      }
      return {
        outcome: "completed",
        summary: {
          collected: result.items.length,
          published: job.payload.shadow ? 0 : dispatchJobs.length,
          shadow: job.payload.shadow,
          source: job.payload.source,
        },
      };
    }

    const destinations = matchingDestinations(options.channels, job.payload);
    const states: Record<string, string> = {};
    if (job.payload.itemKind === "article" && destinations.length > 0) {
      const rateLimit = await options.controlPlane.consumeRateLimits(
        rateLimitInputs(options.channels, job.payload, now()),
      );
      if (!rateLimit.allowed) {
        return { outcome: "deferred", reason: "rate_limit", retryAt: rateLimit.retryAt };
      }
    }
    for (const destination of destinations) {
      const effectKey = `${job.dedupeKey}:${destination}`;
      const claim = await options.controlPlane.claimEffect({
        destination,
        effectKey,
        jobId: job.jobId,
      });
      if (claim.state === "done") {
        states[destination] = "done";
        continue;
      }
      if (claim.state === "uncertain") {
        return { outcome: "uncertain", reason: "effect_uncertain" };
      }
      if (claim.state === "busy") {
        return { outcome: "deferred", reason: "effect_busy", retryAt: claim.retryAt };
      }

      if (job.payload.itemKind !== "article") {
        await enforceRateLimit(options.controlPlane, options.channels, job.payload, now());
      }
      let result: DeliveryResult;
      try {
        result = await deliver(destination, job.payload);
      } catch {
        await options.controlPlane.finishEffect(effectKey, {
          errorClass: "permanent",
          errorMessage: "external delivery outcome uncertain",
          status: "uncertain",
        });
        return { outcome: "uncertain", reason: "external_delivery_uncertain" };
      }
      if (result.outcome === "ok") {
        await options.controlPlane.finishEffect(effectKey, { status: "done" });
        states[destination] = "done";
        continue;
      }
      if (result.outcome === "quota") {
        await options.controlPlane.finishEffect(effectKey, {
          errorClass: "retryable",
          errorMessage: "destination quota unavailable",
          status: "failed",
        });
        throw new TypeError("429 destination quota unavailable");
      }
      const uncertain = result.status === undefined || result.status >= 500;
      await options.controlPlane.finishEffect(effectKey, {
        errorClass: uncertain ? "permanent" : "permanent",
        errorMessage: uncertain
          ? "external delivery outcome uncertain"
          : `destination rejected request: ${result.status}`,
        status: uncertain ? "uncertain" : "failed",
      });
      if (uncertain) {
        return { outcome: "uncertain", reason: "external_delivery_uncertain" };
      }
      throw new Error(
        `destination rejected request: ${result.status}`,
      );
    }

    if (job.payload.itemKind === "link" && options.channels.article_archive.enabled) {
      const article: DispatchItem = {
        itemKind: "article",
        requestedAt: now().toISOString(),
        ...(job.payload.tags ? { tags: job.payload.tags } : {}),
        ...(job.payload.title ? { title: job.payload.title } : {}),
        url: job.payload.url,
      };
      await options.controlPlane.publishJobs(await toDispatchJobs([article], now, randomUuid));
    }
    return { outcome: "completed", summary: { destinations: states } };
  };
}

async function notifyCollection(
  options: JobHandlerOptions,
  job: Extract<QueueJob, { kind: "collect-source" }>,
  collected: number,
  published: number,
): Promise<void> {
  if (!options.notify || collected === 0) return;
  const effectKey = `${job.dedupeKey}:notification`;
  const claim = await options.controlPlane.claimEffect({
    destination: "notification",
    effectKey,
    jobId: job.jobId,
  });
  if (claim.state !== "claimed") return;
  await options.notify({ collected, published, source: job.payload.source });
  await options.controlPlane.finishEffect(effectKey, { status: "done" });
}

async function toDispatchJobs(
  items: readonly DispatchItem[],
  now: () => Date,
  randomUuid: () => string,
): Promise<readonly QueueJob[]> {
  const unique = new Map<string, QueueJob>();
  for (const item of items) {
    const dedupeKey = await createItemDedupeKey(item);
    if (unique.has(dedupeKey)) continue;
    unique.set(
      dedupeKey,
      parseQueueJob({
        createdAt: now().toISOString(),
        dedupeKey,
        jobId: randomUuid(),
        kind: "dispatch-item",
        payload: item,
        schemaVersion: 1,
      }),
    );
  }
  return [...unique.values()];
}

function matchingDestinations(channels: Channels, item: DispatchItem): readonly string[] {
  const configured = Object.entries(channels.destinations)
    .filter(([, entry]) => entry.enabled && entry.item_kind === item.itemKind)
    .map(([name]) => name);
  return item.itemKind === "article" && channels.article_archive.enabled
    ? [...configured, "article_archive"]
    : configured;
}

function createConfiguredDeliverer(options: JobHandlerOptions): DeliverFunction {
  const fetcher = options.fetcher ?? fetch;
  return async (destination, item) => {
    if (destination === "cubox" && item.itemKind === "link") {
      const config = options.channels.destinations.cubox?.config ?? {};
      return deliverCubox(required(config, "api_url", "cubox"), item, fetcher);
    }
    if (destination === "flomo" && item.itemKind === "text") {
      const config = options.channels.destinations.flomo?.config ?? {};
      const apiKey = readOptionalString(options.channels.llm, "glm_api_key") ?? "";
      const model = readOptionalString(options.channels.llm, "model");
      const tags = item.tags?.length
        ? item.tags
        : await generateSmartTags({
            apiKey,
            content: item.content,
            fetcher,
            ...(model ? { model } : {}),
          });
      return deliverFlomo(
        required(config, "webhook", "flomo"),
        { ...item, tags: [...tags] },
        fetcher,
      );
    }
    if (destination === "jianguoyun" && item.itemKind === "file") {
      const config = options.channels.destinations.jianguoyun?.config ?? {};
      const basePath = readOptionalString(config, "base_path");
      const baseUrl = readOptionalString(config, "base_url");
      return deliverJianguoyun(
        {
          ...(basePath ? { basePath } : {}),
          ...(baseUrl ? { baseUrl } : {}),
          password: required(config, "webdav_pass", "jianguoyun"),
          user: required(config, "webdav_user", "jianguoyun"),
        },
        item,
        fetcher,
      );
    }
    if (destination === "article_archive" && item.itemKind === "article" && options.archive) {
      return options.archive(item);
    }
    throw new Error(`destination does not support item: ${destination}/${item.itemKind}`);
  };
}

async function enforceRateLimit(
  controlPlane: WorkerControlPlane,
  channels: Channels,
  item: DispatchItem,
  current: Date,
): Promise<void> {
  for (const input of rateLimitInputs(channels, item, current)) {
    const result = await controlPlane.consumeRateLimit(input);
    if (!result.allowed) throw new TypeError(`429 ${input.scope} rate limit unavailable`);
  }
}

function rateLimitInputs(
  channels: Channels,
  item: DispatchItem,
  current: Date,
): readonly {
  bucketKey: string;
  limit: number;
  scope: string;
  windowSeconds: number;
}[] {
  const policy = ratePolicy(channels, item.itemKind);
  const date = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(current);
  const inputs: Array<{
    bucketKey: string;
    limit: number;
    scope: string;
    windowSeconds: number;
  }> = [];
  if (policy.dailyLimit !== null) {
    inputs.push({
      bucketKey: date,
      limit: policy.dailyLimit,
      scope: `${item.itemKind}:daily`,
      windowSeconds: 86_400,
    });
  }
  if (policy.windowCount > 0) {
    const bucket = String(Math.floor(current.getTime() / (policy.windowSeconds * 1_000)));
    inputs.push({
      bucketKey: bucket,
      limit: policy.windowCount,
      scope: `${item.itemKind}:window`,
      windowSeconds: policy.windowSeconds,
    });
  }
  return inputs;
}

function ratePolicy(channels: Channels, itemKind: DispatchItem["itemKind"]): {
  dailyLimit: number | null;
  windowCount: number;
  windowSeconds: number;
} {
  switch (itemKind) {
    case "link":
      return { dailyLimit: 500, windowCount: 0, windowSeconds: 21_600 };
    case "text":
      return { dailyLimit: 96, windowCount: 25, windowSeconds: 21_600 };
    case "file":
      return { dailyLimit: null, windowCount: 1_400, windowSeconds: 1_800 };
    case "article":
      return {
        dailyLimit: channels.article_archive.daily_limit,
        windowCount: channels.article_archive.rate_window_count,
        windowSeconds: channels.article_archive.rate_window_seconds,
      };
  }
}

function required(config: JsonRecord, key: string, destination: string): string {
  const value = readOptionalString(config, key);
  if (!value) throw new Error(`${destination} requires ${key}`);
  return value;
}
