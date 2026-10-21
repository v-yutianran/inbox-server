import type { CollectionResult } from "./collectors.ts";
import {
  parseBilibiliFavorites,
  parseBilibiliToview,
  parseInoreaderItems,
  parseXTweets,
  parseYoutubeItems,
  parseZhihuCollection,
  xDispatchItem,
  type Bookmark,
  type XTweet,
} from "./parsers.ts";

export interface PageLike {
  url(): string;
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  evaluate(fn: (...args: never[]) => unknown, arg?: unknown): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: () => unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  storageState(): Promise<unknown>;
}

export type BrowserSource = "zhihu" | "bilibili" | "bilibili_toview" | "inoreader" | "youtube" | "x_bookmarks" | "x_likes";

export async function collectBrowserSource(
  source: BrowserSource,
  config: Readonly<Record<string, unknown>>,
  context: BrowserContextLike,
  knownKeys: (source: string) => ReadonlySet<string>,
): Promise<CollectionResult> {
  switch (source) {
    case "zhihu":
      return collectZhihu(config, context, knownKeys("zhihu"));
    case "bilibili":
      return collectBilibili(config, context, knownKeys("bilibili"));
    case "bilibili_toview":
      return collectBilibiliToview(context, knownKeys("bilibili_toview"));
    case "inoreader":
      return collectInoreader(context, knownKeys("inoreader"));
    case "youtube":
      return collectYoutube(context, knownKeys("youtube"));
    case "x_bookmarks":
    case "x_likes":
      return collectX(source, config, context, knownKeys);
  }
}

async function collectZhihu(config: Readonly<Record<string, unknown>>, context: BrowserContextLike, known: ReadonlySet<string>): Promise<CollectionResult> {
  const collectionId = required(config, "collection_id", "zhihu");
  const page = await context.newPage();
  const fresh: Bookmark[] = [];
  try {
    await page.goto("https://www.zhihu.com/", { timeout: 60_000, waitUntil: "commit" });
    for (let offset = 0; offset < 4_000; offset += 20) {
      const payload = await pageJson(page, `https://www.zhihu.com/api/v4/collections/${encodeURIComponent(collectionId)}/items?offset=${offset}&limit=20`);
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

async function collectBilibili(config: Readonly<Record<string, unknown>>, context: BrowserContextLike, known: ReadonlySet<string>): Promise<CollectionResult> {
  const mediaId = required(config, "media_id", "bilibili");
  const page = await context.newPage();
  const fresh: Bookmark[] = [];
  try {
    await page.goto("https://www.bilibili.com/", { timeout: 60_000, waitUntil: "commit" });
    for (let pageNumber = 1; pageNumber <= 200; pageNumber += 1) {
      const payload = await pageJson(page, `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=${pageNumber}&ps=20`);
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

async function collectBilibiliToview(context: BrowserContextLike, known: ReadonlySet<string>): Promise<CollectionResult> {
  const page = await context.newPage();
  try {
    await page.goto("https://www.bilibili.com/", { timeout: 60_000, waitUntil: "commit" });
    const all = parseBilibiliToview(await pageJson(page, "https://api.bilibili.com/x/v2/history/toview/web"));
    const fresh = all.filter(({ key }) => !known.has(key));
    return bookmarks("bilibili_toview", fresh, new Set([...known, ...fresh.map(({ key }) => key)]));
  } finally {
    await page.close();
  }
}

async function collectInoreader(context: BrowserContextLike, known: ReadonlySet<string>): Promise<CollectionResult> {
  const page = await context.newPage();
  try {
    await page.goto("https://www.inoreader.com/starred", { timeout: 60_000, waitUntil: "commit" });
    if (/\/(login|signin)/.test(page.url())) throw new Error("inoreader login expired");
    const items = await scrollExtract(page, extractInoreader, (value) => parseInoreaderItems(value), () => false, ({ key }) => key);
    const fresh = items.filter(({ key }) => !known.has(key));
    return bookmarks("inoreader", fresh, new Set([...known, ...fresh.map(({ key }) => key)]));
  } finally {
    await page.close();
  }
}

async function collectYoutube(context: BrowserContextLike, known: ReadonlySet<string>): Promise<CollectionResult> {
  const page = await context.newPage();
  try {
    await page.goto("https://www.youtube.com/playlist?list=WL", { timeout: 60_000, waitUntil: "commit" });
    await page.waitForSelector('#contents a[href*="watch?v="]', { timeout: 15_000 }).catch(() => undefined);
    const items = await scrollExtract(page, extractYoutube, (value) => parseYoutubeItems(value), (current) => current.some(({ key }) => known.has(key)));
    const fresh = items.filter(({ key }) => !known.has(key));
    return bookmarks("youtube", fresh, new Set([...known, ...fresh.map(({ key }) => key)]));
  } finally {
    await page.close();
  }
}

async function collectX(
  source: "x_bookmarks" | "x_likes",
  config: Readonly<Record<string, unknown>>,
  context: BrowserContextLike,
  knownKeys: (source: string) => ReadonlySet<string>,
): Promise<CollectionResult> {
  const globalKnown = knownKeys("x");
  const sourceKnown = knownKeys(source);
  const username = typeof config.username === "string" ? config.username : "";
  if (source === "x_likes" && !username) throw new Error("x_likes requires username");
  const url = source === "x_bookmarks" ? "https://x.com/i/bookmarks" : `https://x.com/${encodeURIComponent(username)}/likes`;
  const page = await context.newPage();
  try {
    await page.goto(url, { timeout: 60_000, waitUntil: "commit" });
    if (/\/(login|i\/flow\/login|account\/access)/.test(page.url())) throw new Error("x login expired");
    const tweets = await scrollExtract(page, extractXTweets, (value) => parseXTweets(value));
    const fresh = tweets.filter(({ id }) => !globalKnown.has(id));
    const tag = source === "x_bookmarks" ? "x-bookmarks" : "x-likes";
    return {
      items: fresh.map((tweet) => xDispatchItem(tweet, tag)),
      meta: { collected: fresh.length },
      stateUpdates: [
        { key: "baseline:x", value: { knownKeys: [...new Set([...globalKnown, ...tweets.map(({ id }) => id)])] } },
        { key: `baseline:${source}`, value: { knownKeys: [...new Set([...sourceKnown, ...tweets.map(({ id }) => id)])] } },
      ],
    };
  } finally {
    await page.close();
  }
}

export async function scrollExtract<T>(
  page: PageLike,
  extract: () => unknown[],
  parse: (input: readonly unknown[]) => readonly T[],
  shouldStop: (items: readonly T[]) => boolean = () => false,
  stableKey?: (item: T) => string,
): Promise<readonly T[]> {
  const accumulated: T[] = [];
  const keyed = stableKey ? new Map<string, T>() : undefined;
  let previousCount = -1;
  for (let index = 0; index < 20; index += 1) {
    const raw = await page.evaluate(extract as (...args: never[]) => unknown);
    const current = parse(Array.isArray(raw) ? raw : []);
    if (stableKey && keyed) {
      let added = 0;
      for (const item of current) {
        const key = stableKey(item);
        if (keyed.has(key)) continue;
        keyed.set(key, item);
        added += 1;
      }
      if (added === 0) break;
    } else {
      if (current.length === previousCount) break;
      accumulated.splice(0, accumulated.length, ...current);
      previousCount = current.length;
    }
    if (shouldStop(current)) break;
    await page.waitForTimeout(1_500);
  }
  return keyed ? [...keyed.values()] : accumulated;
}

async function pageJson(page: PageLike, url: string): Promise<unknown> {
  const response = await page.evaluate(async (target) => {
    const result = await fetch(String(target), { credentials: "include" });
    return { body: await result.text(), status: result.status };
  }, url);
  if (!isRecord(response) || typeof response.body !== "string" || typeof response.status !== "number") {
    throw new Error("browser collector response is invalid");
  }
  if (response.status === 401 || response.status === 403) throw new Error("browser login expired");
  if (response.status < 200 || response.status >= 300) throw new Error(`browser collector request failed: ${response.status}`);
  return JSON.parse(response.body) as unknown;
}

function bookmarks(source: BrowserSource, fresh: readonly Bookmark[], known: ReadonlySet<string>): CollectionResult {
  return {
    items: fresh.map(({ title, url }) => ({ itemKind: "link" as const, tags: [], title, url })),
    meta: { collected: fresh.length },
    stateUpdates: [{ key: `baseline:${source}`, value: { knownKeys: [...known] } }],
  };
}

function extractInoreader(): unknown[] {
  const titleSelectors = ["a.article_title_link", "a.article_title", ".article_title a", "a[data-article-id]", "h2 a", "h3 a", "a.title"];
  const nodes = Array.from(document.querySelectorAll("div.ar.article, div.ar, div.article, [role='article'], article"));
  return nodes.flatMap((container) => {
    const title = titleSelectors.map((selector) => container.querySelector(selector)).find(Boolean) as HTMLAnchorElement | undefined;
    const url = title?.href ?? "";
    const key = /^article_\d+$/.test(container.id) ? container.id : container.getAttribute("data-article-id") ?? "";
    return url ? [{ key, title: title?.textContent?.trim() || url, url }] : [];
  });
}

function extractYoutube(): unknown[] {
  const seen = new Set<string>();
  return Array.from(document.querySelectorAll('#contents a[href*="watch?v="]')).flatMap((node) => {
    const anchor = node as HTMLAnchorElement;
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
    const link = Array.from(article.querySelectorAll('a[href*="/status/"]')).map((anchor) => (anchor as HTMLAnchorElement).href).find(Boolean) ?? "";
    const id = /\/status\/(\d+)/.exec(link)?.[1] ?? "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const author = article.querySelector("div[data-testid='User-Name']")?.textContent ?? "";
    const text = Array.from(article.querySelectorAll("div[data-testid='tweetText']")).map((node) => node.textContent ?? "").join(" ");
    return [{ author, id, text, url: link }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(config: Readonly<Record<string, unknown>>, key: string, source: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${source} requires ${key}`);
  return value;
}
