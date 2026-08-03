import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { DispatchItem, SourceName } from "@inbox/domain";

import { readOptionalString } from "./channels.js";
import {
  parseDidaTasks,
  parseGithubStars,
  parseTelegramUpdates,
  type Bookmark,
} from "./collector-parsers.js";
import type { CollectionResult, CollectorDependencies } from "./collector-types.js";

const TELEGRAM_API = "https://api.telegram.org";
const DIDA_API = "https://api.dida365.com/open/v1";
const GITHUB_API = "https://api.github.com";

export async function collectHttpSource(
  source: Extract<SourceName, "telegram" | "dida" | "github_stars">,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  switch (source) {
    case "telegram":
      return collectTelegram(dependencies);
    case "dida":
      return collectDida(dependencies);
    case "github_stars":
      return collectGithubStars(dependencies);
  }
}

async function collectTelegram(dependencies: CollectorDependencies): Promise<CollectionResult> {
  const config = sourceConfig(dependencies, "telegram");
  const token = required(config, "bot_token", "telegram");
  const stateKey = `telegram:offset:${await fingerprint(token)}`;
  const currentState = await dependencies.controlPlane.getState(stateKey);
  const offset = readNumber(currentState, "offset") ?? 0;
  const fetcher = dependencies.fetcher ?? fetch;
  const url = new URL(`${TELEGRAM_API}/bot${token}/getUpdates`);
  url.searchParams.set("offset", String(offset + 1));
  url.searchParams.set("timeout", "10");
  url.searchParams.set("allowed_updates", '["message"]');
  const payload = await requestJson(fetcher, url, { method: "GET" });
  const parsed = parseTelegramUpdates(payload, offset);
  const fileItems = await Promise.all(
    parsed.files.map(async (file): Promise<DispatchItem> => {
      const fileResult = await requestJson(
        fetcher,
        `${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(file.fileId)}`,
        { method: "GET" },
      );
      const result = isRecord(fileResult) && isRecord(fileResult.result) ? fileResult.result : {};
      const filePath = readOptionalString(result, "file_path");
      if (!filePath) throw new Error("Telegram getFile response is invalid");
      const response = await fetcher(`${TELEGRAM_API}/file/bot${token}/${filePath}`);
      if (!response.ok) throw new Error(`Telegram file request failed: ${response.status}`);
      await mkdir(dependencies.stagingDir, { recursive: true });
      const remoteName = sanitizeFilename(file.remoteName);
      const localPath = join(dependencies.stagingDir, remoteName);
      await writeFile(localPath, new Uint8Array(await response.arrayBuffer()));
      return { itemKind: "file", localPath, remoteName };
    }),
  );
  return {
    items: [...parsed.items, ...fileItems],
    meta: { collected: parsed.items.length + fileItems.length },
    source: "telegram",
    stateUpdates: parsed.offset > offset
      ? [{ key: stateKey, value: { offset: parsed.offset } }]
      : [],
  };
}

async function collectDida(dependencies: CollectorDependencies): Promise<CollectionResult> {
  const config = sourceConfig(dependencies, "dida");
  const token = required(config, "access_token", "dida");
  const stateKey = `dida:saved:${await fingerprint(token)}`;
  const currentState = await dependencies.controlPlane.getState(stateKey);
  const saved = new Set(readStringArray(currentState, "savedTitles"));
  const fetcher = dependencies.fetcher ?? fetch;
  const headers = { Authorization: `Bearer ${token}` };
  const payload = await requestJson(fetcher, `${DIDA_API}/project/inbox/data`, {
    headers,
    method: "GET",
  });
  const tasks = isRecord(payload) && Array.isArray(payload.tasks) ? payload.tasks : [];
  const parsed = parseDidaTasks(tasks, saved);
  return {
    afterCommit: async () => {
      await Promise.all(
        parsed.deleteTasks.map(async ({ id, projectId }) => {
          const response = await fetcher(
            `${DIDA_API}/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(id)}`,
            { headers, method: "DELETE" },
          );
          if (!response.ok && response.status !== 404) {
            throw new Error(`Dida delete request failed: ${response.status}`);
          }
        }),
      );
    },
    items: parsed.items,
    meta: { collected: parsed.items.length, linkTasks: parsed.deleteTasks.length },
    source: "dida",
    stateUpdates: [
      { key: stateKey, value: { savedTitles: [...parsed.savedTitles].sort() } },
    ],
  };
}

async function collectGithubStars(
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  const config = sourceConfig(dependencies, "github_stars");
  const token = required(config, "token", "github_stars");
  const known = await knownKeys(dependencies, "baseline:github_stars");
  const fetcher = dependencies.fetcher ?? fetch;
  const fresh: Bookmark[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`${GITHUB_API}/user/starred`);
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const payload = await requestJson(fetcher, url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
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
  return bookmarkResult("github_stars", fresh, merged, ["github"]);
}

function bookmarkResult(
  source: SourceName,
  bookmarks: readonly Bookmark[],
  known: ReadonlySet<string>,
  tags: readonly string[] = [],
): CollectionResult {
  return {
    items: bookmarks.map(({ title, url }) => ({
      itemKind: "link" as const,
      tags: [...tags],
      title,
      url,
    })),
    meta: { collected: bookmarks.length },
    source,
    stateUpdates: [{ key: `baseline:${source}`, value: { knownKeys: [...known] } }],
  };
}

function sourceConfig(
  dependencies: CollectorDependencies,
  source: SourceName,
): Readonly<Record<string, unknown>> {
  const entry = dependencies.channels.sources[source];
  if (!entry?.enabled) throw new Error(`source is disabled: ${source}`);
  return entry.config;
}

function required(config: Readonly<Record<string, unknown>>, key: string, source: string): string {
  const value = readOptionalString(config, key);
  if (!value) throw new Error(`${source} requires ${key}`);
  return value;
}

async function knownKeys(
  dependencies: CollectorDependencies,
  key: string,
): Promise<Set<string>> {
  return new Set(readStringArray(await dependencies.controlPlane.getState(key), "knownKeys"));
}

async function requestJson(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(input, init);
  if (!response.ok) throw new Error(`collector request failed: ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("collector response is invalid JSON");
  }
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function readStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key].filter((entry): entry is string => typeof entry === "string");
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value[key] === "number" ? value[key] : undefined;
}

function sanitizeFilename(value: string): string {
  const safe = basename(value).replace(/[^\p{L}\p{N}._ -]/gu, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("unsafe Telegram filename");
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
