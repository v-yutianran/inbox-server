import { createHash, createHmac } from "node:crypto";

const IMA_API_BASE_URL = "https://ima.qq.com/openapi/wiki/v1";

export class ImaMirrorError extends Error {
  readonly stage: string;
  readonly reason: string;
  readonly providerCode?: number;

  constructor(message: string, stage: string, reason: string, providerCode?: number) {
    super(message);
    this.name = "ImaMirrorError";
    this.stage = stage;
    this.reason = reason;
    if (providerCode !== undefined) this.providerCode = providerCode;
  }
}

export interface ImaMirrorInput {
  content: string;
  filename: string;
  sourceUrl: string;
  title: string;
}

export function renderImaMarkdownCopy(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return content;
  const title = frontMatter(match[1] ?? "", "title");
  const sourceUrl = frontMatter(match[1] ?? "", "source_url");
  if (!title && !sourceUrl) return content;
  const body = (match[2] ?? "").trimStart();
  const source = sourceUrl ? `来源：[原文链接](${sourceUrl})` : "";
  return [title ? `# ${title}` : "", body, source].filter(Boolean).join("\n\n");
}

export function buildImaLocation(filename: string): { filename: string; month: string } {
  const base = filename.split("/").pop() ?? filename;
  const match = /^(\d{6})\d{2}-(.+)$/.exec(base);
  if (!match) throw new ImaMirrorError("ima_archive_filename_invalid", "folder", "invalid_filename");
  return { filename: match[2] ?? "", month: match[1] ?? "" };
}

export async function mirrorToIma(options: {
  apiKey: string;
  clientId: string;
  content: string;
  fetcher?: typeof fetch;
  filename: string;
  knowledgeBaseName: string;
  now?: () => Date;
  sourceUrl: string;
  stateGet?: (key: string) => unknown;
  statePut?: (key: string, value: unknown) => void;
  timeoutMs?: number;
  webHeaders?: Record<string, string>;
  webKnowledgeBaseId?: string;
}): Promise<"mirrored" | "skipped"> {
  const fetcher = options.fetcher ?? fetch;
  const fingerprint = sourceFingerprint(options.sourceUrl);
  const stateKey = `ima-mirror:${fingerprint}`;
  if (options.stateGet?.(stateKey) != null) return "skipped";
  const knowledgeBaseId = await findUniqueKnowledgeBase({
    apiKey: options.apiKey,
    clientId: options.clientId,
    fetcher,
    knowledgeBaseName: options.knowledgeBaseName,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const imaContent = renderImaMarkdownCopy(options.content);
  const location = buildImaLocation(options.filename);
  const folderId = await findUniqueMonthFolder({
    apiKey: options.apiKey,
    clientId: options.clientId,
    fetcher,
    knowledgeBaseId,
    month: location.month,
    timeoutMs: options.timeoutMs ?? 30_000,
    webHeaders: options.webHeaders,
    webKnowledgeBaseId: options.webKnowledgeBaseId,
  });
  const fileSize = Buffer.byteLength(imaContent);
  const repeated = await imaRequest<{ results: Array<{ is_repeated: boolean }> }>({
    apiKey: options.apiKey,
    body: {
      folder_id: folderId,
      knowledge_base_id: knowledgeBaseId,
      params: [{ media_type: 7, name: location.filename }],
    },
    clientId: options.clientId,
    fetcher,
    operation: "check_repeated_names",
    stage: "duplicate_check",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (repeated.results[0]?.is_repeated) {
    throw new ImaMirrorError("ima_duplicate_unverified", "duplicate_check", "duplicate_unverified");
  }
  const media = await imaRequest<{ cos_credential: CosCredential; media_id: string }>({
    apiKey: options.apiKey,
    body: {
      content_type: "text/markdown",
      file_ext: "md",
      file_name: location.filename,
      file_size: fileSize,
      knowledge_base_id: knowledgeBaseId,
    },
    clientId: options.clientId,
    fetcher,
    operation: "create_media",
    stage: "create_media",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  await uploadToCos({ content: Buffer.from(imaContent), credential: media.cos_credential, fetcher, timeoutMs: options.timeoutMs ?? 30_000 });
  const now = options.now ?? (() => new Date());
  await imaRequest({
    apiKey: options.apiKey,
    body: {
      file_info: {
        cos_key: media.cos_credential.cos_key,
        file_name: location.filename,
        file_size: fileSize,
        last_modify_time: Math.floor(now().getTime() / 1_000),
        password: "",
      },
      folder_id: folderId,
      knowledge_base_id: knowledgeBaseId,
      media_id: media.media_id,
      media_type: 7,
      title: location.filename,
    },
    clientId: options.clientId,
    fetcher,
    operation: "add_knowledge",
    stage: "add_knowledge",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  options.statePut?.(stateKey, {
    completedAt: now().toISOString(),
    contentDigest: sha256(options.content),
    knowledgeId: sha256(knowledgeBaseId),
  });
  return "mirrored";
}

interface CosCredential {
  bucket_name: string;
  cos_key: string;
  expired_time: number;
  region: string;
  secret_id: string;
  secret_key: string;
  start_time: number;
  token: string;
}

async function findUniqueKnowledgeBase(options: {
  apiKey: string;
  clientId: string;
  fetcher: typeof fetch;
  knowledgeBaseName: string;
  timeoutMs: number;
}): Promise<string> {
  const matches: string[] = [];
  let cursor = "";
  do {
    const page = await imaRequest<{
      addable_knowledge_base_list: Array<{ id: string; name: string }>;
      is_end: boolean;
      next_cursor: string;
    }>({
      apiKey: options.apiKey,
      body: { cursor, limit: 50 },
      clientId: options.clientId,
      fetcher: options.fetcher,
      operation: "get_addable_knowledge_base_list",
      stage: "knowledge_base",
      timeoutMs: options.timeoutMs,
    });
    matches.push(...page.addable_knowledge_base_list.filter((item) => item.name === options.knowledgeBaseName).map((item) => item.id));
    if (page.is_end) break;
    cursor = page.next_cursor;
  } while (cursor);
  if (matches.length !== 1) throw new ImaMirrorError("ima_knowledge_base_not_unique", "knowledge_base", "knowledge_base_not_unique");
  return matches[0] ?? "";
}

async function findUniqueMonthFolder(options: {
  apiKey: string;
  clientId: string;
  fetcher: typeof fetch;
  knowledgeBaseId: string;
  month: string;
  timeoutMs: number;
  webHeaders?: Record<string, string>;
  webKnowledgeBaseId?: string;
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
    matches.push(...page.knowledge_list.filter((item) => item.title === options.month && item.media_id?.startsWith("folder_")).map((item) => item.media_id ?? ""));
    if (page.is_end) break;
    cursor = page.next_cursor;
  } while (cursor);
  if (matches.length === 0 && options.webHeaders && options.webKnowledgeBaseId) {
    const response = await options.fetcher("https://ima.qq.com/cgi-bin/knowledge_tab_writer/create_folder", {
      body: JSON.stringify({
        folder_id: options.webKnowledgeBaseId,
        knowledge_base_id: options.webKnowledgeBaseId,
        title: options.month,
      }),
      headers: {
        "content-type": "application/json",
        cookie: options.webHeaders.cookie ?? "",
        extension_version: "999.999.999",
        from_browser_ima: "1",
        referer: "https://ima.qq.com/wikis",
        "x-ima-bkn": options.webHeaders["x-ima-bkn"] ?? "",
        "x-ima-cookie": options.webHeaders["x-ima-cookie"] ?? "",
      },
      method: "POST",
    });
    if (!response.ok) throw new ImaMirrorError("ima_folder_create_failed", "folder", "http_failed");
    const payload = await response.json() as { code?: number };
    if (payload.code !== 0) throw new ImaMirrorError("ima_folder_create_failed", "folder", "api_rejected", payload.code);
    return findUniqueMonthFolder({ ...options, webHeaders: undefined });
  }
  if (matches.length !== 1) throw new ImaMirrorError("ima_month_folder_not_unique", "folder", "folder_not_unique");
  return matches[0] ?? "";
}

async function imaRequest<T>(options: {
  apiKey: string;
  body: unknown;
  clientId: string;
  fetcher: typeof fetch;
  operation: string;
  stage: string;
  timeoutMs: number;
}): Promise<T> {
  const response = await options.fetcher(`${IMA_API_BASE_URL}/${options.operation}`, {
    body: JSON.stringify(options.body),
    headers: {
      "content-type": "application/json",
      "ima-openapi-apikey": options.apiKey,
      "ima-openapi-clientid": options.clientId,
    },
    method: "POST",
  });
  if (!response.ok) throw new ImaMirrorError(`ima_${options.stage}_failed`, options.stage, "http_failed");
  const payload = await response.json() as { code?: number; data?: T } & T;
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new ImaMirrorError(`ima_${options.stage}_failed`, options.stage, "api_rejected", payload.code);
  }
  return (payload.data ?? payload) as T;
}

async function uploadToCos(options: { content: Buffer; credential: CosCredential; fetcher: typeof fetch; timeoutMs: number }): Promise<void> {
  const hostname = `${options.credential.bucket_name}.cos.${options.credential.region}.myqcloud.com`;
  if (!/^[a-z0-9.-]+\.myqcloud\.com$/i.test(hostname)) throw new ImaMirrorError("ima_cos_host_invalid", "cos_upload", "host_invalid");
  const pathname = `/${options.credential.cos_key.split("/").map(encodeURIComponent).join("/")}`;
  const signedHeaders = { "content-length": String(options.content.length), host: hostname };
  const authorization = cosAuthorization({
    expiredTime: options.credential.expired_time,
    headers: signedHeaders,
    pathname,
    secretId: options.credential.secret_id,
    secretKey: options.credential.secret_key,
    startTime: options.credential.start_time,
  });
  const response = await options.fetcher(`https://${hostname}${pathname}`, {
    body: new Uint8Array(options.content),
    headers: {
      authorization,
      "content-length": String(options.content.length),
      "content-type": "text/markdown",
      "x-cos-security-token": options.credential.token,
    },
    method: "PUT",
  });
  if (!response.ok) throw new ImaMirrorError("ima_cos_upload_failed", "cos_upload", "cos_upload_failed");
}

function cosAuthorization(options: {
  expiredTime: number;
  headers: Readonly<Record<string, string>>;
  pathname: string;
  secretId: string;
  secretKey: string;
  startTime: number;
}): string {
  const keyTime = `${options.startTime};${options.expiredTime}`;
  const signKey = hmac(options.secretKey, keyTime);
  const headerKeys = Object.keys(options.headers).sort();
  const httpHeaders = headerKeys.map((key) => `${key.toLowerCase()}=${encodeURIComponent(options.headers[key] ?? "")}`).join("&");
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

function frontMatter(block: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block);
  if (!match) return "";
  const raw = match[1]?.trim() ?? "";
  if (raw.startsWith("\"") || raw.startsWith("'")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return raw.replace(/^['"]|['"]$/g, "");
    }
  }
  return raw;
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

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string, value: string): string {
  return createHmac("sha1", key).update(value).digest("hex");
}
