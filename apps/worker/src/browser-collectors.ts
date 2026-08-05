import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

import type { DispatchItem, SourceName } from "@inbox/domain";

import { readOptionalString } from "./channels.js";
import {
  parseBilibiliFavorites,
  parseBilibiliToview,
  parseInoreaderItems,
  parseXTweets,
  parseYoutubeItems,
  parseZhihuCollection,
  type Bookmark,
  type XTweet,
} from "./collector-parsers.js";
import type { CollectionResult, CollectorDependencies } from "./collector-types.js";

type BrowserSource = Exclude<SourceName, "telegram" | "dida" | "github_stars">;

const navigationOptionsBySource = {
  bilibili: { timeout: 60_000, waitUntil: "commit" },
  bilibili_toview: { timeout: 60_000, waitUntil: "commit" },
  inoreader: { timeout: 60_000, waitUntil: "commit" },
  x_bookmarks: { timeout: 60_000, waitUntil: "commit" },
  x_likes: { timeout: 60_000, waitUntil: "commit" },
  youtube: { timeout: 60_000, waitUntil: "commit" },
  zhihu: { timeout: 60_000, waitUntil: "commit" },
} as const satisfies Record<BrowserSource, Readonly<{ timeout: number; waitUntil: "commit" }>>;

export function browserNavigationOptions(source: BrowserSource) {
  return navigationOptionsBySource[source];
}

export async function waitForDocumentBody(
  page: Pick<Page, "waitForFunction">,
): Promise<void> {
  await page.waitForFunction(() => document.body !== null, undefined, { timeout: 60_000 });
}

export async function scrollDocumentToEnd(
  page: Pick<Page, "waitForFunction">,
): Promise<void> {
  await page.waitForFunction(() => {
    const body = document.body;
    if (body === null) return false;
    window.scrollTo(0, body.scrollHeight);
    return true;
  }, undefined, { timeout: 60_000 });
}

export function runBrowserOperationWithTimeout<T>(
  operation: () => Promise<T>,
  onTimeout: () => void,
  timeoutMs = 180_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
      } catch {
        // 超时结果优先，context 关闭错误由调用方的健康状态记录。
      }
      reject(new Error("browser source timeout"));
    }, timeoutMs);
    operation().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function collectBrowserSource(
  source: BrowserSource,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const entry = dependencies.channels.sources[source];
  if (!entry?.enabled) throw new Error(`source is disabled: ${source}`);
  const credentialName = required(entry.config, "credential_name", source);
  const platform = source.startsWith("bilibili") ? "bilibili" : source.startsWith("x_") ? "x" : source;
  const credential = await dependencies.controlPlane.getCredential(credentialName);
  if (credential === null) throw new Error(`credential not found: ${credentialName}`);
  const context = await authenticatedContext(dependencies.browser, platform, credential);
  let timedOut = false;
  try {
    return await runBrowserOperationWithTimeout(
      async () => {
        const result = await collectWithContext(source, entry.config, context, dependencies);
        return {
          ...result,
          loginSession: {
            expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
            platform,
            state: await context.storageState(),
            status: "active" as const,
          },
        };
      },
      () => {
        timedOut = true;
        void context.close().catch(() => undefined);
      },
    );
  } finally {
    if (!timedOut) await context.close();
  }
}

async function collectWithContext(
  source: BrowserSource,
  config: Readonly<Record<string, unknown>>,
  context: BrowserContext,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  switch (source) {
    case "zhihu":
      return collectZhihu(config, context, dependencies);
    case "bilibili":
      return collectBilibili(config, context, dependencies);
    case "bilibili_toview":
      return collectBilibiliToview(context, dependencies);
    case "inoreader":
      return collectInoreader(context, dependencies);
    case "youtube":
      return collectYoutube(context, dependencies);
    case "x_bookmarks":
    case "x_likes":
      return collectX(source, config, context, dependencies);
  }
}

async function collectZhihu(
  config: Readonly<Record<string, unknown>>,
  context: BrowserContext,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const collectionId = required(config, "collection_id", "zhihu");
  const known = await baseline(dependencies, "zhihu");
  const page = await context.newPage();
  const fresh: Bookmark[] = [];
  try {
    await page.goto("https://www.zhihu.com/", browserNavigationOptions("zhihu"));
    for (let offset = 0; offset < 4_000; offset += 20) {
      const payload = await pageJson(
        page,
        `https://www.zhihu.com/api/v4/collections/${encodeURIComponent(collectionId)}/items?offset=${offset}&limit=20`,
      );
      const parsed = parseZhihuCollection(payload);
      const pageFresh = parsed.items.filter(({ key }) => !known.has(key));
      fresh.push(...pageFresh);
      if (parsed.items.length === 0 || pageFresh.length === 0 || parsed.isEnd) break;
    }
  } finally {
    await page.close();
  }
  return bookmarks("zhihu", fresh, new Set([...known, ...fresh.map(({ key }) => key)]));
}

async function collectBilibili(
  config: Readonly<Record<string, unknown>>,
  context: BrowserContext,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const mediaId = required(config, "media_id", "bilibili");
  const known = await baseline(dependencies, "bilibili");
  const page = await context.newPage();
  const fresh: Bookmark[] = [];
  try {
    await page.goto("https://www.bilibili.com/", browserNavigationOptions("bilibili"));
    for (let pageNumber = 1; pageNumber <= 200; pageNumber += 1) {
      const payload = await pageJson(
        page,
        `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=${pageNumber}&ps=20`,
      );
      const batch = parseBilibiliFavorites(payload);
      const pageFresh = batch.filter(({ key }) => !known.has(key));
      fresh.push(...pageFresh);
      if (batch.length === 0 || pageFresh.length === 0) break;
    }
  } finally {
    await page.close();
  }
  return bookmarks("bilibili", fresh, new Set([...known, ...fresh.map(({ key }) => key)]));
}

async function collectBilibiliToview(
  context: BrowserContext,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const known = await baseline(dependencies, "bilibili_toview");
  const page = await context.newPage();
  try {
    await page.goto("https://www.bilibili.com/", browserNavigationOptions("bilibili_toview"));
    const all = parseBilibiliToview(
      await pageJson(page, "https://api.bilibili.com/x/v2/history/toview/web"),
    );
    const fresh = all.filter(({ key }) => !known.has(key));
    return bookmarks(
      "bilibili_toview",
      fresh,
      new Set([...known, ...fresh.map(({ key }) => key)]),
    );
  } finally {
    await page.close();
  }
}

async function collectInoreader(
  context: BrowserContext,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const known = await baseline(dependencies, "inoreader");
  const page = await context.newPage();
  try {
    await page.goto("https://www.inoreader.com/starred", browserNavigationOptions("inoreader"));
    await waitForDocumentBody(page);
    if (isInoreaderLoginUrl(page.url())) throw new Error("inoreader login expired");
    await waitForInoreaderContent(page);
    const items = await scrollExtract(
      page,
      extractInoreader,
      (value) => parseInoreaderItems(value),
      undefined,
      ({ key }) => key,
    );
    const fresh = items.filter(({ key }) => !known.has(key));
    return bookmarks("inoreader", fresh, new Set([...known, ...fresh.map(({ key }) => key)]));
  } finally {
    await page.close();
  }
}

async function collectYoutube(
  context: BrowserContext,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const known = await baseline(dependencies, "youtube");
  const page = await context.newPage();
  try {
    await page.goto("https://www.youtube.com/playlist?list=WL", browserNavigationOptions("youtube"));
    await waitForDocumentBody(page);
    await page.waitForSelector('#contents a[href*="watch?v="]', { timeout: 15_000 }).catch(() => undefined);
    const items = await scrollExtract(
      page,
      extractYoutube,
      (value) => parseYoutubeItems(value),
      (current) => current.some(({ key }) => known.has(key)),
    );
    const fresh = items.filter(({ key }) => !known.has(key));
    return bookmarks("youtube", fresh, new Set([...known, ...fresh.map(({ key }) => key)]));
  } finally {
    await page.close();
  }
}

async function collectX(
  source: "x_bookmarks" | "x_likes",
  config: Readonly<Record<string, unknown>>,
  context: BrowserContext,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const globalKnown = await baseline(dependencies, "x");
  const sourceKnown = await baseline(dependencies, source);
  const username = readOptionalString(config, "username");
  if (source === "x_likes" && !username) throw new Error("x_likes requires username");
  const url = source === "x_bookmarks"
    ? "https://x.com/i/bookmarks"
    : `https://x.com/${encodeURIComponent(username!)}/likes`;
  const page = await context.newPage();
  try {
    await page.goto(url, browserNavigationOptions(source));
    await waitForDocumentBody(page);
    if (/\/(login|i\/flow\/login|account\/access)/.test(page.url())) {
      throw new Error("x login expired");
    }
    const tweets = await scrollExtract(page, extractXTweets, (value) => parseXTweets(value));
    const fresh = tweets.filter(({ id }) => !globalKnown.has(id));
    const tag = source === "x_bookmarks" ? "x-bookmarks" : "x-likes";
    return {
      items: fresh.map((tweet) => xItem(tweet, tag)),
      meta: { collected: fresh.length },
      source,
      stateUpdates: [
        { key: "baseline:x", value: { knownKeys: [...new Set([...globalKnown, ...tweets.map(({ id }) => id)])] } },
        { key: `baseline:${source}`, value: { knownKeys: [...new Set([...sourceKnown, ...tweets.map(({ id }) => id)])] } },
      ],
    };
  } finally {
    await page.close();
  }
}

export async function authenticatedContext(
  browser: Browser,
  platform: string,
  credential: unknown,
): Promise<BrowserContext> {
  const record = isRecord(credential) ? credential : {};
  const storageState = isRecord(record.storage_state) ? record.storage_state : record;
  if (Array.isArray(storageState.cookies) || Array.isArray(storageState.origins)) {
    return browser.newContext({
      storageState: storageState as Exclude<BrowserContextOptions["storageState"], undefined>,
    });
  }
  const context = await browser.newContext();
  if (platform === "zhihu" && typeof record.z_c0 === "string") {
    await context.addCookies([{ domain: ".zhihu.com", name: "z_c0", path: "/", value: record.z_c0 }]);
  } else if (platform === "bilibili" && typeof record.sessdata === "string") {
    await context.addCookies([{ domain: ".bilibili.com", name: "SESSDATA", path: "/", value: record.sessdata }]);
  } else {
    await context.close();
    throw new Error(`unsupported browser credential: ${platform}`);
  }
  return context;
}

async function baseline(
  dependencies: CollectorDependencies,
  source: string,
): Promise<Set<string>> {
  const state = await dependencies.controlPlane.getState(`baseline:${source}`);
  if (!isRecord(state) || !Array.isArray(state.knownKeys)) return new Set();
  return new Set(state.knownKeys.filter((value): value is string => typeof value === "string"));
}

function bookmarks(
  source: SourceName,
  fresh: readonly Bookmark[],
  known: ReadonlySet<string>,
): CollectionResult {
  return {
    items: fresh.map(({ title, url }) => ({ itemKind: "link" as const, tags: [], title, url })),
    meta: { collected: fresh.length },
    source,
    stateUpdates: [{ key: `baseline:${source}`, value: { knownKeys: [...known] } }],
  };
}

function xItem(tweet: XTweet, tag: string): DispatchItem {
  const text = tweet.text.slice(0, 140);
  const title = tweet.author && text
    ? `${tweet.author}: ${text}`
    : tweet.author || text || tweet.url;
  return { itemKind: "link", tags: ["x", tag], title, url: tweet.url };
}

async function pageJson(page: Page, url: string): Promise<unknown> {
  const response = await page.evaluate(async (target) => {
    const result = await fetch(target, { credentials: "include" });
    return { body: await result.text(), status: result.status };
  }, url);
  if (response.status === 401 || response.status === 403) throw new Error("browser login expired");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`browser collector request failed: ${response.status}`);
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("browser collector response is invalid JSON");
  }
}

export async function scrollExtract<T>(
  page: Page,
  extract: () => unknown[],
  parse: (input: readonly unknown[]) => readonly T[],
  shouldStop: (items: readonly T[]) => boolean = () => false,
  stableKey?: (item: T) => string,
): Promise<readonly T[]> {
  const accumulated: T[] = [];
  const keyedItems = stableKey ? new Map<string, T>() : undefined;
  let previousCount = -1;
  for (let index = 0; index < 20; index += 1) {
    const current = parse(await page.evaluate(extract));
    if (stableKey && keyedItems) {
      let added = 0;
      for (const item of current) {
        const key = stableKey(item);
        if (keyedItems.has(key)) continue;
        keyedItems.set(key, item);
        added += 1;
      }
      if (added === 0) break;
    } else {
      if (current.length === previousCount) break;
      accumulated.splice(0, accumulated.length, ...current);
      previousCount = current.length;
    }
    if (shouldStop(current)) break;
    await scrollDocumentToEnd(page);
    await page.waitForTimeout(1_500);
  }
  return keyedItems ? [...keyedItems.values()] : accumulated;
}

function extractInoreader(): unknown[] {
  const titleSelectors = [
    "a.article_title_link", "a.article_title", ".article_title a",
    "a[data-article-id]", "h2 a", "h3 a", "a.title",
  ];
  return Array.from(document.querySelectorAll("div.ar.article, div.ar, div.article, [role='article'], article")).flatMap((container) => {
    const title = titleSelectors.map((selector) => container.querySelector<HTMLAnchorElement>(selector)).find(Boolean);
    const url = title?.href ?? "";
    const key = /^article_\d+$/.test(container.id)
      ? container.id
      : container.getAttribute("data-article-id") ?? "";
    return url ? [{ key, title: title?.textContent?.trim() || url, url }] : [];
  });
}

function extractYoutube(): unknown[] {
  const seen = new Set<string>();
  return Array.from(document.querySelectorAll<HTMLAnchorElement>('#contents a[href*="watch?v="]')).flatMap((anchor) => {
    const url = new URL(anchor.href, location.href);
    const videoId = url.searchParams.get("v") ?? "";
    if (!videoId || seen.has(videoId)) return [];
    seen.add(videoId);
    return [{ title: anchor.getAttribute("title") || anchor.textContent?.trim() || videoId, videoId }];
  });
}

function extractXTweets(): unknown[] {
  const seen = new Set<string>();
  return Array.from(document.querySelectorAll("article[data-testid='tweet']")).flatMap((article) => {
    const link = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).map((anchor) => anchor.href).find(Boolean) ?? "";
    const id = /\/status\/(\d+)/.exec(link)?.[1] ?? "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const author = article.querySelector("div[data-testid='User-Name']")?.textContent ?? "";
    const text = Array.from(article.querySelectorAll("div[data-testid='tweetText']")).map((node) => node.textContent ?? "").join(" ");
    return [{ author, id, text, url: link }];
  });
}

function required(config: Readonly<Record<string, unknown>>, key: string, source: string): string {
  const value = readOptionalString(config, key);
  if (!value) throw new Error(`${source} requires ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INOREADER_READY_SELECTOR = [
  ':is(div.ar.article, div.ar, div.article, [role="article"], article):is([id^="article_"], [data-article-id])',
  ':is(a.article_title_link, a.article_title, .article_title a, a[data-article-id], h2 a, h3 a, a.title)[href]',
].join(" ");

async function waitForInoreaderContent(page: Page): Promise<void> {
  try {
    await page.waitForSelector(INOREADER_READY_SELECTOR, { timeout: 60_000 });
  } catch {
    if (isInoreaderLoginUrl(page.url())) throw new Error("inoreader login expired");
    throw new Error("inoreader content not ready: timeout");
  }
}

function isInoreaderLoginUrl(url: string): boolean {
  return /\/(login|signin)/.test(url);
}
