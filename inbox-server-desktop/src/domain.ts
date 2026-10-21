import { createHash } from "node:crypto";

export const sourceNames = ["dida", "github_stars", "telegram"] as const;
export type SourceName = (typeof sourceNames)[number];
export type ItemKind = "link" | "text" | "file" | "article";

export type DispatchItem =
  | { itemKind: "link"; url: string; title?: string; tags?: string[] }
  | { itemKind: "text"; content: string; tags?: string[] }
  | { itemKind: "file"; remoteName: string; localPath?: string; objectKey?: string }
  | { itemKind: "article"; url: string; title?: string; tags?: string[]; requestedAt: string };

export interface QueueJob {
  schemaVersion: 1;
  jobId: string;
  dedupeKey: string;
  createdAt: string;
  kind: "dispatch-item";
  payload: DispatchItem;
}

export interface RateLimitInput {
  scope: string;
  bucketKey: string;
  limit: number;
  windowSeconds: number;
}

export interface RatePolicy {
  dailyLimit: number | null;
  windowCount: number;
  windowSeconds: number;
  intervalMs: number;
}

/** 与当前 Worker 的额度对齐。本地写文件不再插入云端那几秒间隔，额度本身保持不变。 */
export const RATE_POLICIES: Record<ItemKind, RatePolicy> = {
  link: { dailyLimit: 500, windowCount: 0, windowSeconds: 21_600, intervalMs: 0 },
  text: { dailyLimit: 96, windowCount: 25, windowSeconds: 21_600, intervalMs: 0 },
  file: { dailyLimit: null, windowCount: 1_400, windowSeconds: 1_800, intervalMs: 0 },
  article: { dailyLimit: 10_000, windowCount: 60, windowSeconds: 3_600, intervalMs: 0 },
};

const MESSAGE_OVERHEAD = 100;
const MAX_MESSAGE_BYTES = 128_000;
const MAX_BATCH_BYTES = 256_000;
const MAX_BATCH_COUNT = 100;
const TAG_NOISE = /[\s#。，,、！!?？:：;；（）()【】\[\]"'“”‘’`]+/gu;

export class QueueBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueBatchError";
  }
}

export function createItemDedupeKey(item: DispatchItem): string {
  const digest = createHash("sha256").update(itemIdentity(item)).digest("hex");
  return `dispatch:${item.itemKind}:${digest}`;
}

export function fingerprintSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shanghaiDateKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(now);
}

export function shanghaiCompactDate(now: Date): string {
  return shanghaiDateKey(now).replaceAll("-", "");
}

export function rateLimitInputs(itemKind: ItemKind, now: Date, policy: RatePolicy = RATE_POLICIES[itemKind]): RateLimitInput[] {
  const inputs: RateLimitInput[] = [];
  if (policy.dailyLimit !== null) {
    inputs.push({
      scope: `${itemKind}:daily`,
      bucketKey: shanghaiDateKey(now),
      limit: policy.dailyLimit,
      windowSeconds: 86_400,
    });
  }
  if (policy.windowCount > 0) {
    inputs.push({
      scope: `${itemKind}:window`,
      bucketKey: String(Math.floor(now.getTime() / (policy.windowSeconds * 1_000))),
      limit: policy.windowCount,
      windowSeconds: policy.windowSeconds,
    });
  }
  return inputs;
}

/**
 * 先校验整批，再按 100 条或 256KB 切开。
 * 云端 Queue 有这条上限；本地写入前同样拒绝超大消息，避免导入半批脏数据。
 */
export function planQueueBatches(bodies: readonly unknown[]): unknown[][] {
  const encoder = new TextEncoder();
  const messages = bodies.map((body) => {
    const bytes = encoder.encode(JSON.stringify(body)).byteLength + MESSAGE_OVERHEAD;
    if (bytes > MAX_MESSAGE_BYTES) throw new QueueBatchError("Queue message exceeds 128 KB");
    return { body, bytes };
  });
  const batches: unknown[][] = [];
  let batch: unknown[] = [];
  let batchBytes = 0;
  for (const message of messages) {
    if (batch.length === MAX_BATCH_COUNT || batchBytes + message.bytes > MAX_BATCH_BYTES) {
      if (batch.length === 0) throw new QueueBatchError("Queue message exceeds batch limit");
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(message.body);
    batchBytes += message.bytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function buildArchiveFilename(title: string, archivedAt: Date, collision?: string): string {
  const date = shanghaiCompactDate(archivedAt);
  const normalized = title.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "untitled";
  const suffix = collision ? `-${collision}` : "";
  const prefix = `${date}-`;
  const extension = ".md";
  let safeTitle = "";
  let bytes = Buffer.byteLength(`${prefix}${suffix}${extension}`, "utf8");
  for (const character of normalized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > 171) break;
    safeTitle += character;
    bytes += characterBytes;
  }
  return `${prefix}${safeTitle}${suffix}${extension}`;
}

export function parseSmartTags(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[，,\n、]/u)
    .map((tag) => tag.replace(TAG_NOISE, "").trim())
    .filter((tag) => tag.length >= 2)
    .slice(0, 3);
}

export function formatFlomoContent(content: string, tags: readonly string[]): string {
  const prefix = tags.map((tag) => `#${tag}`).join(" ");
  return prefix ? `${prefix} ${content}` : content;
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fff]+/gu, "_").replace(/^\.+/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return [...cleaned].slice(0, 80).join("");
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function extractUrlTitlePairs(text: string): Array<{ title: string; url: string }> {
  const pairs: Array<{ title: string; url: string }> = [];
  const occupied = new Set<string>();
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = trimUrl(match[2] ?? "");
    if (!isHttpUrl(url) || occupied.has(url)) continue;
    pairs.push({ title: cleanText(match[1] ?? "") || url, url });
    occupied.add(url);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>()\]]+/g)) {
    const url = trimUrl(match[0]);
    if (!isHttpUrl(url) || occupied.has(url)) continue;
    pairs.push({ title: url, url });
    occupied.add(url);
  }
  return pairs;
}

export function visibleCharacters(value: string): number {
  return value.replace(/\s+/gu, "").length;
}

function itemIdentity(item: DispatchItem): string {
  switch (item.itemKind) {
    case "link":
    case "article":
      return item.url;
    case "text":
      return item.content;
    case "file":
      return item.remoteName;
  }
}

function trimUrl(value: string): string {
  return value.replace(/[.,;!?，。；！？]+$/u, "");
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
