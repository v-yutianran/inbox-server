import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  extractUrlTitlePairs,
  fingerprintSecret,
  isHttpUrl,
  sanitizeFilename,
  type DispatchItem,
} from "./domain.ts";

const DIDA_API = "https://api.dida365.com/open/v1";
const GITHUB_API = "https://api.github.com";
const TELEGRAM_API = "https://api.telegram.org";

export interface Bookmark {
  key: string;
  title: string;
  url: string;
}

export interface CollectionResult {
  items: DispatchItem[];
  stateUpdates: Array<{ key: string; value: unknown }>;
  cleanup?: () => Promise<void>;
  meta: Record<string, number>;
}

export interface CollectorState {
  getState(key: string): unknown;
}

export function parseDidaTasks(
  input: readonly unknown[],
  saved: ReadonlySet<string>,
): {
  deleteTasks: Array<{ id: string; projectId: string }>;
  items: DispatchItem[];
  savedTitles: Set<string>;
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

export function parseGithubStars(input: unknown): Bookmark[] {
  if (!Array.isArray(input)) throw new Error("unexpected GitHub starred response");
  return input.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const url = stringValue(raw.html_url);
    if (!isHttpUrl(url)) return [];
    return [{ key: url, title: stringValue(raw.full_name) || url, url }];
  });
}

export function parseTelegramUpdates(
  input: unknown,
  currentOffset: number,
): { files: Array<{ fileId: string; remoteName: string }>; items: DispatchItem[]; offset: number } {
  const root = isRecord(input) ? input : {};
  const updates = Array.isArray(root.result) ? root.result : [];
  const files: Array<{ fileId: string; remoteName: string }> = [];
  const items: DispatchItem[] = [];
  let offset = currentOffset;
  for (const rawUpdate of updates) {
    if (!isRecord(rawUpdate)) continue;
    if (typeof rawUpdate.update_id === "number") offset = Math.max(offset, rawUpdate.update_id);
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
      items.push(...pairs.map(({ title, url }) => ({ itemKind: "link" as const, tags: [], title, url })));
    } else {
      items.push({ content: text, itemKind: "text" });
    }
  }
  return { files, items, offset };
}

export async function collectDida(options: {
  token: string;
  state: CollectorState;
  fetcher: typeof fetch;
}): Promise<CollectionResult> {
  const stateKey = `dida:saved:${fingerprintSecret(options.token)}`;
  const saved = new Set(readStringArray(options.state.getState(stateKey), "savedTitles"));
  const headers = { Authorization: `Bearer ${options.token}` };
  const payload = await requestJson(options.fetcher, `${DIDA_API}/project/inbox/data`, { headers, method: "GET" });
  const tasks = isRecord(payload) && Array.isArray(payload.tasks) ? payload.tasks : [];
  const parsed = parseDidaTasks(tasks, saved);
  return {
    cleanup: async () => {
      for (const task of parsed.deleteTasks) {
        const response = await options.fetcher(
          `${DIDA_API}/project/${encodeURIComponent(task.projectId)}/task/${encodeURIComponent(task.id)}`,
          { headers, method: "DELETE" },
        );
        if (!response.ok && response.status !== 404) {
          throw new Error(`Dida delete request failed: ${response.status}`);
        }
      }
    },
    items: parsed.items,
    meta: { collected: parsed.items.length, linkTasks: parsed.deleteTasks.length },
    stateUpdates: [{ key: stateKey, value: { savedTitles: [...parsed.savedTitles].sort() } }],
  };
}

export async function collectGithubStars(options: {
  token: string;
  state: CollectorState;
  fetcher: typeof fetch;
}): Promise<CollectionResult> {
  const known = new Set(readStringArray(options.state.getState("baseline:github_stars"), "knownKeys"));
  const fresh: Bookmark[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`${GITHUB_API}/user/starred`);
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const payload = await requestJson(options.fetcher, url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      method: "GET",
    });
    const bookmarks = parseGithubStars(payload);
    const pageFresh = bookmarks.filter(({ key }) => !known.has(key));
    fresh.push(...pageFresh);
    if (bookmarks.length < 100 || pageFresh.length === 0) break;
  }
  const merged = new Set([...known, ...fresh.map(({ key }) => key)]);
  return {
    items: fresh.map(({ title, url }) => ({ itemKind: "link", tags: ["github"], title, url })),
    meta: { collected: fresh.length },
    stateUpdates: [{ key: "baseline:github_stars", value: { knownKeys: [...merged] } }],
  };
}

export async function collectTelegram(options: {
  token: string;
  state: CollectorState;
  fetcher: typeof fetch;
  stagingDir: string;
}): Promise<CollectionResult> {
  const stateKey = `telegram:offset:${fingerprintSecret(options.token)}`;
  const current = options.state.getState(stateKey);
  const offset = readNumber(current, "offset") ?? 0;
  const url = new URL(`${TELEGRAM_API}/bot${options.token}/getUpdates`);
  url.searchParams.set("offset", String(offset + 1));
  url.searchParams.set("timeout", "0");
  url.searchParams.set("allowed_updates", '["message"]');
  const payload = await requestJson(options.fetcher, url, { method: "GET" });
  const parsed = parseTelegramUpdates(payload, offset);
  const fileItems: DispatchItem[] = [];
  for (const file of parsed.files) {
    const fileResult = await requestJson(
      options.fetcher,
      `${TELEGRAM_API}/bot${options.token}/getFile?file_id=${encodeURIComponent(file.fileId)}`,
      { method: "GET" },
    );
    const result = isRecord(fileResult) && isRecord(fileResult.result) ? fileResult.result : {};
    const filePath = stringValue(result.file_path);
    if (!filePath) throw new Error("Telegram getFile response is invalid");
    const response = await options.fetcher(`${TELEGRAM_API}/file/bot${options.token}/${filePath}`);
    if (!response.ok) throw new Error(`Telegram file request failed: ${response.status}`);
    await mkdir(options.stagingDir, { recursive: true });
    const remoteName = sanitizeFilename(file.remoteName);
    const localPath = join(options.stagingDir, remoteName);
    await writeFile(localPath, new Uint8Array(await response.arrayBuffer()));
    fileItems.push({ itemKind: "file", localPath, remoteName });
  }
  return {
    items: [...parsed.items, ...fileItems],
    meta: { collected: parsed.items.length + fileItems.length },
    stateUpdates: parsed.offset > offset ? [{ key: stateKey, value: { offset: parsed.offset } }] : [],
  };
}

async function requestJson(fetcher: typeof fetch, input: string | URL, init: RequestInit): Promise<unknown> {
  const response = await fetcher(input, init);
  if (!response.ok) throw new Error(`collector request failed: ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("collector response is invalid JSON");
  }
}

function extractUrlAndTitle(title: string, content: string): { title: string; url: string } | null {
  const pair = extractUrlTitlePairs(`${title}\n${content}`)[0];
  if (!pair) return null;
  const cleanTitle = title.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1").trim().replace(/\s+/g, " ");
  return { title: cleanTitle || pair.title, url: pair.url };
}

function telegramFile(message: Record<string, unknown>): { fileId: string; remoteName: string } | null {
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const photo = photos.at(-1);
  if (isRecord(photo)) {
    const fileId = stringValue(photo.file_id);
    if (fileId) return { fileId, remoteName: `${fileId}.jpg` };
  }
  const candidates: Array<[string, string]> = [
    ["document", ""],
    ["video", ".mp4"],
    ["voice", ".ogg"],
    ["audio", ".mp3"],
  ];
  for (const [field, extension] of candidates) {
    const entry = isRecord(message[field]) ? message[field] : null;
    if (!entry) continue;
    const fileId = stringValue(entry.file_id);
    if (!fileId) continue;
    return { fileId, remoteName: stringValue(entry.file_name) || `${fileId}${extension}` };
  }
  return null;
}

function readStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter((item): item is string => typeof item === "string");
}

function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === "number" ? value[key] : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
