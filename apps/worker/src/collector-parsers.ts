import type { DispatchItem } from "@inbox/domain";

export interface Bookmark {
  readonly key: string;
  readonly title: string;
  readonly url: string;
}

export interface TelegramFile {
  readonly fileId: string;
  readonly remoteName: string;
}

export interface XTweet {
  readonly author: string;
  readonly id: string;
  readonly text: string;
  readonly url: string;
}

export function parseTelegramUpdates(
  input: unknown,
  currentOffset: number,
): {
  readonly files: readonly TelegramFile[];
  readonly items: readonly DispatchItem[];
  readonly offset: number;
} {
  const root = isRecord(input) ? input : {};
  const updates = Array.isArray(root.result) ? root.result : [];
  const files: TelegramFile[] = [];
  const items: DispatchItem[] = [];
  let offset = currentOffset;
  for (const rawUpdate of updates) {
    if (!isRecord(rawUpdate)) continue;
    if (typeof rawUpdate.update_id === "number") {
      offset = Math.max(offset, rawUpdate.update_id);
    }
    const message = isRecord(rawUpdate.message) ? rawUpdate.message : {};
    const file = telegramFile(message);
    if (file) {
      files.push(file);
      continue;
    }
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) continue;
    const pairs = extractUrlTitlePairs(text);
    if (pairs.length > 0) {
      items.push(
        ...pairs.map(({ title, url }) => ({ itemKind: "link" as const, tags: [], title, url })),
      );
    } else {
      items.push({ content: text, itemKind: "text" });
    }
  }
  return { files, items, offset };
}

export function parseDidaTasks(
  input: readonly unknown[],
  saved: ReadonlySet<string>,
): {
  readonly deleteTasks: readonly { id: string; projectId: string }[];
  readonly items: readonly DispatchItem[];
  readonly savedTitles: ReadonlySet<string>;
} {
  const deleteTasks: Array<{ id: string; projectId: string }> = [];
  const items: DispatchItem[] = [];
  const savedTitles = new Set(saved);
  for (const rawTask of input) {
    if (!isRecord(rawTask)) continue;
    const title = stringValue(rawTask.title);
    const content = stringValue(rawTask.content);
    const pair = extractUrlAndTitle(title, content);
    if (!pair) continue;
    const id = stringValue(rawTask.id);
    const projectId = stringValue(rawTask.projectId);
    if (id && projectId) deleteTasks.push({ id, projectId });
    if (!saved.has(title)) {
      items.push({ itemKind: "link", tags: [], title: pair.title || pair.url, url: pair.url });
      savedTitles.add(title);
    }
  }
  return { deleteTasks, items, savedTitles };
}

export function parseGithubStars(input: unknown): readonly Bookmark[] {
  if (!Array.isArray(input)) throw new Error("unexpected GitHub starred response");
  return input.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const url = stringValue(raw.html_url);
    if (!isHttpUrl(url)) return [];
    const title = stringValue(raw.full_name) || url;
    return [{ key: url, title, url }];
  });
}

export function parseZhihuCollection(input: unknown): {
  readonly isEnd: boolean;
  readonly items: readonly Bookmark[];
} {
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
      if (!url) {
        url = `https://www.zhihu.com/question/${stringValue(question.id)}/answer/${stringValue(content.id)}`;
      }
      title = stringValue(question.title) || title;
    } else if (type === "article" && !url) {
      url = `https://zhuanlan.zhihu.com/p/${stringValue(content.id)}`;
    }
    if (!isHttpUrl(url)) return [];
    const clippedTitle = title.length > 100 ? `${title.slice(0, 100)}...` : title;
    return [{ key: url, title: clippedTitle || url, url }];
  });
  const paging = isRecord(root.paging) ? root.paging : {};
  return { isEnd: paging.is_end === true, items };
}

export function parseBilibiliFavorites(input: unknown): readonly Bookmark[] {
  const root = isRecord(input) ? input : {};
  const data = isRecord(root.data) ? root.data : {};
  return parseBilibiliVideos(Array.isArray(data.medias) ? data.medias : []);
}

export function parseBilibiliToview(input: unknown): readonly Bookmark[] {
  const root = isRecord(input) ? input : {};
  const data = isRecord(root.data) ? root.data : {};
  return parseBilibiliVideos(Array.isArray(data.list) ? data.list : []);
}

export function parseInoreaderItems(input: readonly unknown[]): readonly Bookmark[] {
  return uniqueBookmarks(
    input.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const key = stringValue(raw.key);
      const url = stringValue(raw.url);
      if (!key || !isHttpUrl(url)) return [];
      return [{ key, title: stringValue(raw.title) || url, url }];
    }),
  );
}

export function parseYoutubeItems(input: readonly unknown[]): readonly Bookmark[] {
  return uniqueBookmarks(
    input.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const key = stringValue(raw.videoId);
      if (!key) return [];
      const url = `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;
      return [{ key, title: stringValue(raw.title) || url, url }];
    }),
  );
}

export function parseXTweets(input: readonly unknown[]): readonly XTweet[] {
  const seen = new Set<string>();
  const tweets: XTweet[] = [];
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const rawUrl = stringValue(raw.url);
    const id = /^\d+$/.test(stringValue(raw.id))
      ? stringValue(raw.id)
      : /\/status\/(\d+)/.exec(rawUrl)?.[1] ?? "";
    if (!id || seen.has(id)) continue;
    const url = isHttpUrl(rawUrl) ? rawUrl : `https://x.com/i/status/${id}`;
    tweets.push({
      author: cleanText(stringValue(raw.author)),
      id,
      text: cleanText(stringValue(raw.text)),
      url,
    });
    seen.add(id);
  }
  return tweets;
}

export function extractUrlTitlePairs(text: string): readonly { title: string; url: string }[] {
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

function telegramFile(message: Record<string, unknown>): TelegramFile | null {
  const candidates: Array<[string, string]> = [
    ["document", ""],
    ["video", ".mp4"],
    ["voice", ".ogg"],
    ["audio", ".mp3"],
    ["animation", ".gif"],
  ];
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const photo = photos.at(-1);
  if (isRecord(photo)) {
    const fileId = stringValue(photo.file_id);
    if (fileId) return { fileId, remoteName: `${fileId}.jpg` };
  }
  for (const [field, extension] of candidates) {
    const entry = isRecord(message[field]) ? message[field] : null;
    if (!entry) continue;
    const fileId = stringValue(entry.file_id);
    if (!fileId) continue;
    return { fileId, remoteName: stringValue(entry.file_name) || `${fileId}${extension}` };
  }
  return null;
}

function extractUrlAndTitle(title: string, content: string): { title: string; url: string } | null {
  const combined = `${title}\n${content}`;
  const pair = extractUrlTitlePairs(combined)[0];
  if (!pair) return null;
  const cleanTitle = cleanText(title.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1"));
  return { title: cleanTitle || pair.title, url: pair.url };
}

function parseBilibiliVideos(input: readonly unknown[]): readonly Bookmark[] {
  return uniqueBookmarks(
    input.flatMap((raw) => {
      if (!isRecord(raw)) return [];
      const bvid = stringValue(raw.bvid);
      if (!bvid) return [];
      const url = `https://www.bilibili.com/video/${bvid}`;
      return [{ key: url, title: stringValue(raw.title) || bvid, url }];
    }),
  );
}

function uniqueBookmarks(input: readonly Bookmark[]): readonly Bookmark[] {
  const seen = new Set<string>();
  return input.filter(({ key }) => (seen.has(key) ? false : (seen.add(key), true)));
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function trimUrl(value: string): string {
  return value.replace(/[.,;!?，。；！？]+$/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
