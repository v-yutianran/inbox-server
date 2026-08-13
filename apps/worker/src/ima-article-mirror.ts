import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import type { ArticleMirror } from "./article-archive.js";

const IMA_API_BASE_URL = "https://ima.qq.com/openapi/wiki/v1";
const MARKDOWN_MEDIA_TYPE = 7;

type Log = (event: string, context: Readonly<Record<string, unknown>>) => void;

interface ImaOptions {
  readonly apiKey?: string | undefined;
  readonly clientId?: string | undefined;
  readonly enabled: boolean;
  readonly fetcher?: typeof fetch;
  readonly knowledgeBaseName?: string | undefined;
  readonly log?: Log;
  readonly now?: () => Date;
  readonly stateDirectory?: string | undefined;
  readonly timeoutMs?: number;
}

interface CosCredential {
  readonly bucket_name: string;
  readonly cos_key: string;
  readonly expired_time: number;
  readonly region: string;
  readonly secret_id: string;
  readonly secret_key: string;
  readonly start_time: number;
  readonly token: string;
}

class ImaMirrorError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

export function renderImaMarkdownCopy(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return content;
  let metadata: unknown;
  try {
    metadata = parse(match[1]!);
  } catch {
    return content;
  }
  if (!isRecord(metadata)) return content;
  const title = stringMetadata(metadata.title);
  const sourceUrl = stringMetadata(metadata.source_url);
  if (!title && !sourceUrl) return content;
  const body = match[2]!.trimStart();
  const source = sourceUrl ? `来源：[原文链接](${sourceUrl})` : "";
  return [title ? `# ${title}` : "", body, source].filter(Boolean).join("\n\n");
}

export function createImaArticleMirror(options: ImaOptions): ArticleMirror {
  if (!options.enabled) return { mirror: async () => undefined };
  const apiKey = required(options.apiKey, "ima_api_key_missing");
  const clientId = required(options.clientId, "ima_client_id_missing");
  const knowledgeBaseName = required(
    options.knowledgeBaseName,
    "ima_knowledge_base_name_missing",
  );
  const stateDirectory = required(options.stateDirectory, "ima_state_directory_missing");
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  let knowledgeBaseId: string | undefined;

  return {
    async mirror(input): Promise<void> {
      const startedAt = Date.now();
      try {
        const markerPath = join(stateDirectory, `${sourceFingerprint(input.sourceUrl)}.json`);
        if (await markerExists(markerPath)) return;
        knowledgeBaseId ??= await findUniqueKnowledgeBase({
          apiKey,
          clientId,
          fetcher,
          knowledgeBaseName,
          timeoutMs,
        });
        const imaContent = renderImaMarkdownCopy(input.content);
        const { filename: imaFilename, month } = buildImaLocation(input.filename);
        const folderId = await findUniqueMonthFolder({
          apiKey,
          clientId,
          fetcher,
          knowledgeBaseId,
          month,
          timeoutMs,
        });
        const fileSize = Buffer.byteLength(imaContent);
        const repeated = await imaRequest<{ results: Array<{ is_repeated: boolean }> }>({
          apiKey,
          body: {
            folder_id: folderId,
            knowledge_base_id: knowledgeBaseId,
            params: [{ media_type: MARKDOWN_MEDIA_TYPE, name: imaFilename }],
          },
          clientId,
          fetcher,
          operation: "check_repeated_names",
          stage: "duplicate_check",
          timeoutMs,
        });
        if (repeated.results[0]?.is_repeated) {
          throw new ImaMirrorError(
            "ima_duplicate_unverified",
            "duplicate_check",
            "duplicate_unverified",
          );
        }
        const media = await imaRequest<{
          cos_credential: CosCredential;
          media_id: string;
        }>({
          apiKey,
          body: {
            content_type: "text/markdown",
            file_ext: "md",
            file_name: imaFilename,
            file_size: fileSize,
            knowledge_base_id: knowledgeBaseId,
          },
          clientId,
          fetcher,
          operation: "create_media",
          stage: "create_media",
          timeoutMs,
        });
        await uploadToCos({
          content: Buffer.from(imaContent),
          credential: media.cos_credential,
          fetcher,
          timeoutMs,
        });
        await imaRequest({
          apiKey,
          body: {
            file_info: {
              cos_key: media.cos_credential.cos_key,
              file_name: imaFilename,
              file_size: fileSize,
              last_modify_time: Math.floor(now().getTime() / 1_000),
              password: "",
            },
            folder_id: folderId,
            knowledge_base_id: knowledgeBaseId,
            media_id: media.media_id,
            media_type: MARKDOWN_MEDIA_TYPE,
            title: imaFilename,
          },
          clientId,
          fetcher,
          operation: "add_knowledge",
          stage: "add_knowledge",
          timeoutMs,
        });
        await writeMarker(markerPath, {
          completedAt: now().toISOString(),
          contentDigest: sha256(input.content),
          knowledgeId: sha256(knowledgeBaseId),
        });
        options.log?.("article.ima_mirror.succeeded", {
          durationBucket: durationBucket(Date.now() - startedAt),
          provider: "ima",
          result: "succeeded",
          stage: "complete",
        });
      } catch (error: unknown) {
        const failure = error instanceof ImaMirrorError
          ? error
          : new ImaMirrorError("ima_unknown_failed", "unknown", "unknown");
        options.log?.("article.ima_mirror.failed", {
          durationBucket: durationBucket(Date.now() - startedAt),
          provider: "ima",
          reason: failure.reason,
          result: "failed",
          stage: failure.stage,
        });
        throw failure;
      }
    },
  };
}

function buildImaLocation(filename: string): { readonly filename: string; readonly month: string } {
  const match = /^(\d{6})\d{2}-(.+)$/.exec(filename);
  if (!match) throw new ImaMirrorError("ima_archive_filename_invalid", "folder", "invalid_filename");
  return { filename: match[2]!, month: match[1]! };
}

async function findUniqueMonthFolder(options: {
  readonly apiKey: string;
  readonly clientId: string;
  readonly fetcher: typeof fetch;
  readonly knowledgeBaseId: string;
  readonly month: string;
  readonly timeoutMs: number;
}): Promise<string> {
  const matches: string[] = [];
  let cursor = "";
  do {
    const page = await imaRequest<{
      is_end: boolean;
      knowledge_list: Array<{ media_id?: string; title?: string }>;
      next_cursor: string;
    }>({
      apiKey: options.apiKey,
      body: { cursor, knowledge_base_id: options.knowledgeBaseId, limit: 50 },
      clientId: options.clientId,
      fetcher: options.fetcher,
      operation: "get_knowledge_list",
      stage: "folder",
      timeoutMs: options.timeoutMs,
    });
    matches.push(
      ...page.knowledge_list
        .filter((item) => item.title === options.month && item.media_id?.startsWith("folder_"))
        .map((item) => item.media_id!),
    );
    if (page.is_end) break;
    cursor = page.next_cursor;
  } while (cursor);
  if (matches.length !== 1) {
    throw new ImaMirrorError("ima_month_folder_not_unique", "folder", "folder_not_unique");
  }
  return matches[0]!;
}

async function findUniqueKnowledgeBase(options: {
  readonly apiKey: string;
  readonly clientId: string;
  readonly fetcher: typeof fetch;
  readonly knowledgeBaseName: string;
  readonly timeoutMs: number;
}): Promise<string> {
  const matches: string[] = [];
  let cursor = "";
  do {
    const page = await imaRequest<{
      addable_knowledge_base_list: Array<{ id: string; name: string }>;
      is_end: boolean;
      next_cursor: string;
    }>({
      ...options,
      body: { cursor, limit: 50 },
      operation: "get_addable_knowledge_base_list",
      stage: "knowledge_base",
    });
    matches.push(
      ...page.addable_knowledge_base_list
        .filter((item) => item.name === options.knowledgeBaseName)
        .map((item) => item.id),
    );
    if (page.is_end) break;
    cursor = page.next_cursor;
  } while (cursor);
  if (matches.length !== 1) {
    throw new ImaMirrorError(
      "ima_knowledge_base_not_unique",
      "knowledge_base",
      "knowledge_base_not_unique",
    );
  }
  return matches[0]!;
}

async function imaRequest<T = unknown>(options: {
  readonly apiKey: string;
  readonly body: unknown;
  readonly clientId: string;
  readonly fetcher: typeof fetch;
  readonly operation: string;
  readonly stage: string;
  readonly timeoutMs: number;
}): Promise<T> {
  let response: Response;
  try {
    response = await options.fetcher(`${IMA_API_BASE_URL}/${options.operation}`, {
      body: JSON.stringify(options.body),
      headers: {
        "Content-Type": "application/json",
        "ima-openapi-apikey": options.apiKey,
        "ima-openapi-clientid": options.clientId,
      },
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new ImaMirrorError(`ima_${options.stage}_failed`, options.stage, "network_failed");
  }
  if (!response.ok) {
    throw new ImaMirrorError(`ima_${options.stage}_failed`, options.stage, "http_failed");
  }
  try {
    const payload = await response.json() as { code?: number; data?: T } & T;
    if (typeof payload.code === "number" && payload.code !== 0) {
      throw new ImaMirrorError(`ima_${options.stage}_failed`, options.stage, "api_rejected");
    }
    return (payload.data ?? payload) as T;
  } catch (error: unknown) {
    if (error instanceof ImaMirrorError) throw error;
    throw new ImaMirrorError(`ima_${options.stage}_failed`, options.stage, "invalid_response");
  }
}

async function uploadToCos(options: {
  readonly content: Buffer;
  readonly credential: CosCredential;
  readonly fetcher: typeof fetch;
  readonly timeoutMs: number;
}): Promise<void> {
  const hostname = `${options.credential.bucket_name}.cos.${options.credential.region}.myqcloud.com`;
  if (!/^[a-z0-9.-]+\.myqcloud\.com$/i.test(hostname)) {
    throw new ImaMirrorError("ima_cos_host_invalid", "cos_upload", "host_invalid");
  }
  const pathname = `/${options.credential.cos_key.split("/").map(encodeURIComponent).join("/")}`;
  const signedHeaders = {
    "content-length": String(options.content.length),
    host: hostname,
  };
  const authorization = cosAuthorization({
    expiredTime: options.credential.expired_time,
    headers: signedHeaders,
    pathname,
    secretId: options.credential.secret_id,
    secretKey: options.credential.secret_key,
    startTime: options.credential.start_time,
  });
  let response: Response;
  try {
    response = await options.fetcher(`https://${hostname}${pathname}`, {
      body: options.content as unknown as BodyInit,
      headers: {
        Authorization: authorization,
        "Content-Length": String(options.content.length),
        "Content-Type": "text/markdown",
        "x-cos-security-token": options.credential.token,
      },
      method: "PUT",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new ImaMirrorError("ima_cos_upload_failed", "cos_upload", "cos_upload_failed");
  }
  if (!response.ok) {
    throw new ImaMirrorError("ima_cos_upload_failed", "cos_upload", "cos_upload_failed");
  }
}

function cosAuthorization(options: {
  readonly expiredTime: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly pathname: string;
  readonly secretId: string;
  readonly secretKey: string;
  readonly startTime: number;
}): string {
  const keyTime = `${options.startTime};${options.expiredTime}`;
  const signKey = hmac(options.secretKey, keyTime);
  const headerKeys = Object.keys(options.headers).sort();
  const httpHeaders = headerKeys
    .map((key) => `${key.toLowerCase()}=${encodeURIComponent(options.headers[key]!)}`)
    .join("&");
  const httpString = `put\n${options.pathname}\n\n${httpHeaders}\n`;
  const signature = hmac(signKey, `sha1\n${keyTime}\n${sha1(httpString)}\n`);
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${options.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerKeys.map((key) => key.toLowerCase()).join(";")}`,
    "q-url-param-list=",
    `q-signature=${signature}`,
  ].join("&");
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeMarker(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function sourceFingerprint(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "spm" || key === "from") url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return sha256(url.toString());
}

function required(value: string | undefined, message: string): string {
  if (!value?.trim()) throw new ImaMirrorError(message, "configuration", "configuration_missing");
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function durationBucket(durationMs: number): string {
  if (durationMs < 1_000) return "lt_1s";
  if (durationMs < 5_000) return "1s_5s";
  if (durationMs < 30_000) return "5s_30s";
  return "gte_30s";
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string, value: string): string {
  return createHmac("sha1", key).update(value).digest("hex");
}
