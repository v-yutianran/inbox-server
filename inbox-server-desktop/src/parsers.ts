import { isHttpUrl } from "./domain.ts";
import type { DispatchItem } from "./domain.ts";

export interface Bookmark {
  key: string;
  title: string;
  url: string;
}

export interface XTweet {
  author: string;
  id: string;
  text: string;
  url: string;
}

export function parseZhihuCollection(input: unknown): { isEnd: boolean; items: Bookmark[] } {
  const root = isRecord(input) ? input : {};
  const data = Array.isArray(root.data) ? root.data : [];
  const items = data.flatMap((rawEntry) => {
    if (!isRecord(rawEntry)) return [];
    const content = isRecord(rawEntry.content) ? rawEntry.content : rawEntry;
    const type = stringValue(content.type);
    let url = stringValue(content.url);
    let title = stringValue(content.title) || stringValue(content.excerpt);
    if (type === "answer") {
      const question = isRecord(content.question) ? content.question : {};
      if (!url) url = `https://www.zhihu.com/question/${stringValue(question.id)}/answer/${stringValue(content.id)}`;
      title = stringValue(question.title) || title;
    } else if (type === "article" && !url) {
      url = `https://zhuanlan.zhihu.com/p/${stringValue(content.id)}`;
    }
    if (!isHttpUrl(url)) return [];
    const clipped = title.length > 100 ? `${title.slice(0, 100)}...` : title;
    return [{ key: url, title: clipped || url, url }];
  });
  const paging = isRecord(root.paging) ? root.paging : {};
  return { isEnd: paging.is_end === true, items };
}

export function parseBilibiliFavorites(input: unknown): Bookmark[] {
  const root = isRecord(input) ? input : {};
  const data = isRecord(root.data) ? root.data : {};
  return parseBilibiliVideos(Array.isArray(data.medias) ? data.medias : []);
}

export function parseBilibiliToview(input: unknown): Bookmark[] {
  const root = isRecord(input) ? input : {};
  const data = isRecord(root.data) ? root.data : {};
  return parseBilibiliVideos(Array.isArray(data.list) ? data.list : []);
}

export function parseInoreaderItems(input: readonly unknown[]): Bookmark[] {
  return unique(input.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const key = stringValue(raw.key);
    const url = stringValue(raw.url);
    if (!key || !isHttpUrl(url)) return [];
    return [{ key, title: stringValue(raw.title) || url, url }];
  }));
}

export function parseYoutubeItems(input: readonly unknown[]): Bookmark[] {
  return unique(input.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const key = stringValue(raw.videoId);
    if (!key) return [];
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;
    return [{ key, title: stringValue(raw.title) || url, url }];
  }));
}

export function parseXTweets(input: readonly unknown[]): XTweet[] {
  const seen = new Set<string>();
  const tweets: XTweet[] = [];
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const rawUrl = stringValue(raw.url);
    const id = /^\d+$/.test(stringValue(raw.id)) ? stringValue(raw.id) : /\/status\/(\d+)/.exec(rawUrl)?.[1] ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tweets.push({
      author: stringValue(raw.author).replace(/\s+/g, " ").trim(),
      id,
      text: stringValue(raw.text).replace(/\s+/g, " ").trim(),
      url: isHttpUrl(rawUrl) ? rawUrl : `https://x.com/i/status/${id}`,
    });
  }
  return tweets;
}

export function xDispatchItem(tweet: XTweet, tag: string): DispatchItem {
  const text = tweet.text.slice(0, 140);
  const title = tweet.author && text ? `${tweet.author}: ${text}` : tweet.author || text || tweet.url;
  return { itemKind: "link", tags: ["x", tag], title, url: tweet.url };
}

function parseBilibiliVideos(input: readonly unknown[]): Bookmark[] {
  return unique(input.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const bvid = stringValue(raw.bvid);
    if (!bvid) return [];
    const url = `https://www.bilibili.com/video/${bvid}`;
    return [{ key: url, title: stringValue(raw.title) || bvid, url }];
  }));
}

function unique(input: readonly Bookmark[]): Bookmark[] {
  const seen = new Set<string>();
  return input.filter(({ key }) => (seen.has(key) ? false : (seen.add(key), true)));
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
