import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { Defuddle } from "defuddle/node";
import { Eta } from "eta";
import { errors, type Browser } from "playwright";

import type { DispatchItem } from "@inbox/domain";

import { authenticatedContext } from "./browser-collectors.js";
import { readOptionalString, type Channels } from "./channels.js";
import type { DeliveryResult } from "./destinations.js";

const execFileAsync = promisify(execFile);
const ARTICLE_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
const ARTICLE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const ARTICLE_ERROR_MARKERS = [
  "访问过于频繁",
  "当前请求存在异常",
  "环境异常",
  "请完成验证",
  "unable to access",
  "access denied",
  "this content is not available",
] as const;

export interface ExtractedArticle {
  readonly author: string;
  readonly markdown: string;
  readonly publishedAt: string;
  readonly title: string;
}

export interface ArticleRepository {
  save(input: {
    readonly content: string;
    readonly filename: string;
    readonly sourceUrl: string;
  }): Promise<{ readonly created: boolean; readonly filename: string }>;
}

export interface ArticleCorrelation {
  readonly dedupeKey: string;
  readonly jobId: string;
}

interface ArticleAssessment {
  readonly reason: "error_marker" | "missing_title" | "short_content" | null;
  readonly valid: boolean;
  readonly visibleCharacters: number;
}

interface ZhihuArticleRequest {
  readonly apiPath: string;
  readonly contentField: "content" | "content_html";
  readonly origin: "https://www.zhihu.com" | "https://zhuanlan.zhihu.com";
  readonly titleField: "excerpt_title" | "question" | "title";
}

export async function extractArticle(url: string, html: string): Promise<ExtractedArticle> {
  const result = await Defuddle(html, url, { markdown: true });
  return {
    author: String(result.author ?? "").trim(),
    markdown: String(result.contentMarkdown ?? result.content ?? "").trim(),
    publishedAt: String(result.published ?? "").trim(),
    title: String(result.title ?? "").trim(),
  };
}

export function renderArticleMarkdown(
  template: string,
  input: {
    readonly archivedAt: string;
    readonly article: ExtractedArticle;
    readonly sourceUrl: string;
    readonly tags: readonly string[];
  },
): string {
  const eta = new Eta({ autoEscape: false, autoTrim: false });
  const output = eta.renderString(template, {
    archived_at_yaml: yamlScalar(input.archivedAt),
    author_yaml: yamlScalar(input.article.author),
    markdown: input.article.markdown.trim(),
    published_at_yaml: yamlScalar(input.article.publishedAt),
    source_url_yaml: yamlScalar(input.sourceUrl),
    tags_yaml: JSON.stringify(input.tags),
    title_yaml: yamlScalar(input.article.title),
  });
  return `${output.trim()}\n`;
}

export function buildArchiveFilename(title: string, archivedAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(archivedAt);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}${values.month}${values.day}`;
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "untitled";
  return `${date}-${safeTitle}.md`;
}

export function createArticleArchiver(options: {
  readonly browser: Browser;
  readonly channels: Channels;
  readonly fetcher?: typeof fetch;
  readonly getCredential?: (name: string) => Promise<unknown | null>;
  readonly log?: (event: string, context: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => Date;
  readonly recordEvent?: (event: {
    readonly filename: string | null;
    readonly reason: string | null;
    readonly sourceUrl: string;
    readonly status: string;
    readonly title: string;
    readonly urlFingerprint: string;
  }) => Promise<void>;
  readonly repository: ArticleRepository;
  readonly templatePath: string;
}): (
  item: Extract<DispatchItem, { itemKind: "article" }>,
  correlation?: ArticleCorrelation,
) => Promise<DeliveryResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  return async (item, correlation) => {
    const correlated = correlation ?? {};
    const fingerprint = await urlFingerprint(item.url);
    let usedBrowser = false;
    let article: ExtractedArticle;
    try {
      const zhihuRequest = resolveZhihuArticleRequest(item.url);
      if (zhihuRequest) {
        const zhihu = options.channels.sources.zhihu;
        const credentialName = zhihu
          ? readOptionalString(zhihu.config, "credential_name") ?? zhihu.credential_ref
          : undefined;
        if (!credentialName) throw new Error("zhihu_credential_name_missing");
        if (!options.getCredential) throw new Error("zhihu_credential_provider_missing");
        const credential = await options.getCredential(credentialName);
        if (credential === null) throw new Error("zhihu_credential_missing");
        article = await fetchZhihuArticle(
          options.browser,
          credential,
          item.url,
          options.channels.article_archive.browser_timeout_seconds,
          options.channels.article_archive.max_html_bytes,
        );
      } else {
        let directArticle: ExtractedArticle | null = null;
        let directAssessment: ArticleAssessment | null = null;
        try {
          directArticle = withFallbackTitle(
            await fetchAndExtract(
              fetcher,
              item.url,
              options.channels.article_archive.http_timeout_seconds,
              options.channels.article_archive.max_html_bytes,
            ),
            item.title ?? "",
          );
          directAssessment = assessArticle(
            directArticle,
            options.channels.article_archive.min_visible_characters,
          );
        } catch (error: unknown) {
          options.log?.("article.extract.direct.rejected", {
            ...correlated,
            description: "文章直接提取失败，准备使用浏览器渲染",
            reason: safeErrorCode(error),
            urlFingerprint: fingerprint,
          });
        }
        if (directArticle && directAssessment?.valid) {
          article = directArticle;
          options.log?.("article.extract.direct.succeeded", {
            ...correlated,
            description: "文章直接提取成功",
            urlFingerprint: fingerprint,
            visibleCharacters: directAssessment.visibleCharacters,
          });
        } else {
          usedBrowser = true;
          if (directAssessment) {
            options.log?.("article.extract.direct.rejected", {
              ...correlated,
              description: "文章直接提取未通过正文验收，准备使用浏览器渲染",
              reason: directAssessment.reason,
              urlFingerprint: fingerprint,
              visibleCharacters: directAssessment.visibleCharacters,
            });
          }
          article = withFallbackTitle(
            await browserExtract(
              options.browser,
              item.url,
              options.channels.article_archive.browser_timeout_seconds,
              options.channels.article_archive.max_html_bytes,
            ),
            item.title ?? "",
          );
        }
      }
      const assessment = zhihuRequest
        ? null
        : assessArticle(article, options.channels.article_archive.min_visible_characters);
      if (assessment && !assessment.valid) {
        options.log?.("article.extract.failed", {
          ...correlated,
          description: "浏览器渲染后的文章仍未通过正文验收",
          reason: assessment.reason,
          urlFingerprint: fingerprint,
          visibleCharacters: assessment.visibleCharacters,
        });
        await options.recordEvent?.({
          filename: null,
          reason: assessment.reason,
          sourceUrl: item.url,
          status: "skipped",
          title: article.title || item.title || "",
          urlFingerprint: fingerprint,
        });
        return { outcome: "ok" };
      }
      if (assessment && usedBrowser) {
        options.log?.("article.extract.browser.succeeded", {
          ...correlated,
          description: "浏览器渲染后的文章提取成功",
          urlFingerprint: fingerprint,
          visibleCharacters: assessment.visibleCharacters,
        });
      }
      const archivedAt = now();
      const normalized = {
        ...article,
        title: article.title || item.title || item.url,
      };
      const markdown = renderArticleMarkdown(await readFile(options.templatePath, "utf8"), {
        archivedAt: archivedAt.toISOString(),
        article: normalized,
        sourceUrl: item.url,
        tags: item.tags ?? [],
      });
      if (Buffer.byteLength(markdown) > options.channels.article_archive.max_output_bytes) {
        throw new Error("article_output_too_large");
      }
      const saved = await options.repository.save({
        content: markdown,
        filename: buildArchiveFilename(normalized.title, archivedAt),
        sourceUrl: item.url,
      });
      await options.recordEvent?.({
        filename: saved.filename,
        reason: null,
        sourceUrl: item.url,
        status: saved.created ? "committed" : "exists",
        title: normalized.title,
        urlFingerprint: fingerprint,
      });
      return { outcome: "ok" };
    } catch (error: unknown) {
      options.log?.("article.archive.failed", {
        ...correlated,
        description: "文章归档失败",
        errorCode: safeErrorCode(error),
        urlFingerprint: fingerprint,
      });
      await options.recordEvent?.({
        filename: null,
        reason: safeErrorCode(error),
        sourceUrl: item.url,
        status: "failed",
        title: item.title ?? "",
        urlFingerprint: fingerprint,
      });
      return { outcome: "fail" };
    }
  };
}

export class GitArticleRepository implements ArticleRepository {
  readonly #articlesDir: string;
  readonly #askpassPath: string;
  readonly #branch: string;
  readonly #githubToken: string;
  readonly #repositoryDir: string;
  readonly #repositoryUrl: string;

  constructor(options: {
    readonly articlesDir: string;
    readonly askpassPath: string;
    readonly branch?: string;
    readonly githubToken: string;
    readonly repositoryDir: string;
    readonly repositoryUrl: string;
  }) {
    if (options.articlesDir.startsWith("/") || options.articlesDir.split("/").includes("..")) {
      throw new Error("article repository path must be relative");
    }
    this.#articlesDir = options.articlesDir;
    this.#askpassPath = options.askpassPath;
    this.#branch = options.branch ?? "main";
    this.#githubToken = options.githubToken;
    this.#repositoryDir = resolve(options.repositoryDir);
    this.#repositoryUrl = options.repositoryUrl;
  }

  async save(input: {
    readonly content: string;
    readonly filename: string;
    readonly sourceUrl: string;
  }): Promise<{ readonly created: boolean; readonly filename: string }> {
    const initialized = await this.#ensureRepository();
    if (!initialized && !(await this.#remoteBranchMatchesHead())) {
      await this.#pullRebaseSafely();
    }
    const existing = await this.#findSourceUrl(input.sourceUrl);
    if (existing) {
      await this.#commitAndPush(join(this.#repositoryDir, this.#articlesDir, existing));
      return { created: false, filename: existing };
    }
    const directory = join(this.#repositoryDir, this.#articlesDir);
    await mkdir(directory, { recursive: true });
    const filename = await this.#collisionSafeFilename(directory, input.filename, input.sourceUrl);
    const target = join(directory, filename);
    const temporary = join(directory, `.article-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(input.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await this.#commitAndPush(target);
    return { created: true, filename };
  }

  async #commitAndPush(target: string): Promise<void> {
    const path = relative(this.#repositoryDir, target);
    const status = await this.#git("status", "--porcelain", "--untracked-files=all", "--", path);
    if (status.trim()) {
      await this.#git("add", "--", path);
      const filename = path.slice(path.lastIndexOf("/") + 1);
      await this.#git(
        "commit",
        "--only",
        "-m",
        `docs(article): 归档《${filename.slice(0, -3)}》`,
        "--",
        path,
      );
    }
    await this.#pushWithRebaseRetry();
  }

  async #ensureRepository(): Promise<boolean> {
    if (await exists(join(this.#repositoryDir, ".git"))) {
      try {
        await this.#git("rev-parse", "--verify", "HEAD");
        return false;
      } catch {
        await rename(this.#repositoryDir, `${this.#repositoryDir}.incomplete-${Date.now()}`);
      }
    } else if (await exists(this.#repositoryDir)) {
      await rename(this.#repositoryDir, `${this.#repositoryDir}.incomplete-${Date.now()}`);
    }
    await mkdir(dirname(this.#repositoryDir), { recursive: true });
    await this.#runGit(
      buildInitialCloneArgs({
        branch: this.#branch,
        repositoryDir: this.#repositoryDir,
        repositoryUrl: this.#repositoryUrl,
      }),
      180_000,
    );
    return true;
  }

  async #findSourceUrl(sourceUrl: string): Promise<string | null> {
    const directory = join(this.#repositoryDir, this.#articlesDir);
    if (!(await exists(directory))) return null;
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith(".md")) continue;
      const content = await readFile(join(directory, entry), "utf8");
      const match = /^source_url:\s*(.+)$/m.exec(content);
      if (!match) continue;
      try {
        if (JSON.parse(match[1]!) === sourceUrl) return entry;
      } catch {
        continue;
      }
    }
    return null;
  }

  async #collisionSafeFilename(
    directory: string,
    filename: string,
    sourceUrl: string,
  ): Promise<string> {
    if (!(await exists(join(directory, filename)))) return filename;
    const fingerprint = (await urlFingerprint(sourceUrl)).slice(0, 8);
    return `${filename.slice(0, -3)}-${fingerprint}.md`;
  }

  async #remoteBranchMatchesHead(): Promise<boolean> {
    const [localHead, remoteBranch] = await Promise.all([
      this.#git("rev-parse", "HEAD"),
      this.#git("ls-remote", "--heads", "origin", this.#branch),
    ]);
    return remoteBranch.trim().split(/\s+/, 1)[0] === localHead.trim();
  }

  async #pullRebaseSafely(): Promise<void> {
    const attempts = gitCommandAttempts("pull");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#gitWithAttempts(1, "pull", "--rebase", "origin", this.#branch);
        return;
      } catch (error) {
        try {
          await this.#gitWithAttempts(1, "rebase", "--abort");
        } catch {
          // pull 在建立 rebase 状态前失败时没有可中止的操作。
        }
        if (attempt === attempts) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
      }
    }
  }

  async #pushWithRebaseRetry(): Promise<void> {
    const attempts = gitCommandAttempts("push");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.#gitWithAttempts(1, "push", "origin", `HEAD:${this.#branch}`);
        return;
      } catch (error) {
        if (attempt === attempts) throw error;
        await this.#pullRebaseSafely();
      }
    }
  }

  async #git(...args: string[]): Promise<string> {
    const command = args[0] ?? "command";
    return this.#gitWithAttempts(gitCommandAttempts(command), ...args);
  }

  async #gitWithAttempts(attempts: number, ...args: string[]): Promise<string> {
    const command = args[0] ?? "command";
    return this.#runGit(
      ["-c", `safe.directory=${this.#repositoryDir}`, "-C", this.#repositoryDir, ...args],
      gitCommandTimeoutMs(command),
      attempts,
      command,
    );
  }

  async #runGit(
    args: string[],
    timeout = 30_000,
    attempts = 1,
    command = args[0] ?? "command",
  ): Promise<string> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await execFileAsync("git", args, {
          env: {
            ...process.env,
            ...directGitProxyEnvironment(),
            GIT_ASKPASS: this.#askpassPath,
            GIT_ASKPASS_REQUIRE: "force",
            GIT_AUTHOR_EMAIL: "v-yutianran@users.noreply.github.com",
            GIT_AUTHOR_NAME: "Inbox Article Worker",
            GIT_COMMITTER_EMAIL: "v-yutianran@users.noreply.github.com",
            GIT_COMMITTER_NAME: "Inbox Article Worker",
            GIT_TERMINAL_PROMPT: "0",
            GITHUB_TOKEN: this.#githubToken,
          },
          maxBuffer: 1_000_000,
          timeout,
        });
        return result.stdout;
      } catch {
        if (attempt === attempts) {
          throw new Error(`git_${command.replace(/[^a-z0-9]+/gi, "_")}_failed`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
      }
    }
    throw new Error("git_command_failed");
  }
}

export function gitCommandAttempts(command: string): number {
  return command === "ls-remote" || command === "pull" || command === "push" ? 3 : 1;
}

export function gitCommandTimeoutMs(command: string): number {
  return command === "ls-remote" || command === "pull" || command === "push"
    ? 180_000
    : 30_000;
}

export function directGitProxyEnvironment(): Record<string, string> {
  return {
    ALL_PROXY: "",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    all_proxy: "",
    http_proxy: "",
    https_proxy: "",
  };
}

export function buildInitialCloneArgs(options: {
  readonly branch: string;
  readonly repositoryDir: string;
  readonly repositoryUrl: string;
}): string[] {
  return [
    "clone",
    "--depth",
    "1",
    "--branch",
    options.branch,
    "--single-branch",
    options.repositoryUrl,
    options.repositoryDir,
  ];
}

async function fetchAndExtract(
  fetcher: typeof fetch,
  url: string,
  timeoutSeconds: number,
  maxBytes: number,
): Promise<ExtractedArticle> {
  const response = await fetcher(url, {
    headers: {
      "Accept-Language": ARTICLE_ACCEPT_LANGUAGE,
      "User-Agent": ARTICLE_USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutSeconds * 1_000),
  });
  if (!response.ok) throw new Error(`article_http_${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new Error("article_unsupported_content_type");
  }
  const html = await response.text();
  if (Buffer.byteLength(html) > maxBytes) throw new Error("article_html_too_large");
  if (html.trim().length < 100) throw new Error("article_html_empty");
  return extractArticle(url, html);
}

export async function fetchZhihuArticle(
  browser: Browser,
  credential: unknown,
  url: string,
  timeoutSeconds: number,
  maxBytes: number,
): Promise<ExtractedArticle> {
  const request = resolveZhihuArticleRequest(url);
  if (!request) throw new Error("unsupported_zhihu_article_url");
  const context = await authenticatedContext(browser, "zhihu", credential);
  const page = await context.newPage();
  try {
    await page.goto(request.origin, { timeout: timeoutSeconds * 1_000, waitUntil: "commit" });
    const result = await withTimeout(
      page.evaluate(async (apiPath) => {
        const response = await fetch(apiPath, { credentials: "include" });
        return { body: await response.text(), status: response.status };
      }, request.apiPath),
      timeoutSeconds * 1_000,
      "zhihu_api_timeout",
    );
    if (result.status !== 200) throw new Error("zhihu_api_rejected");
    if (Buffer.byteLength(result.body) > maxBytes) throw new Error("article_html_too_large");
    const payload: unknown = JSON.parse(result.body);
    return extractArticle(url, buildZhihuDocument(payload, request));
  } finally {
    await context.close();
  }
}

async function browserExtract(
  browser: Browser,
  url: string,
  timeoutSeconds: number,
  maxBytes: number,
): Promise<ExtractedArticle> {
  const timeoutMs = timeoutSeconds * 1_000;
  const context = await browser.newContext({
    extraHTTPHeaders: { "Accept-Language": ARTICLE_ACCEPT_LANGUAGE },
    locale: "zh-CN",
    userAgent: ARTICLE_USER_AGENT,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
    if (isWeChatArticleUrl(url)) {
      await ignorePlaywrightTimeout(
        page.waitForSelector("#js_content", {
          state: "attached",
          timeout: Math.min(timeoutMs, 15_000),
        }),
      );
    }
    await ignorePlaywrightTimeout(
      page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 10_000) }),
    );
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_000);
    const html = await page.content();
    if (Buffer.byteLength(html) > maxBytes) throw new Error("article_html_too_large");
    if (html.trim().length < 100) throw new Error("article_html_empty");
    return extractArticle(url, html);
  } finally {
    await context.close();
  }
}

function resolveZhihuArticleRequest(url: string): ZhihuArticleRequest | null {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.hostname === "www.zhihu.com" &&
    segments.length >= 4 &&
    segments[0] === "question" &&
    segments[2] === "answer"
  ) {
    return {
      apiPath: `/api/v4/answers/${segments[3]}?include=content,excerpt,question,author,created_time`,
      contentField: "content",
      origin: "https://www.zhihu.com",
      titleField: "question",
    };
  }
  if (parsed.hostname === "zhuanlan.zhihu.com" && segments[0] === "p" && segments[1]) {
    return {
      apiPath: `/api/articles/${segments[1]}`,
      contentField: "content",
      origin: "https://zhuanlan.zhihu.com",
      titleField: "title",
    };
  }
  const pinId =
    parsed.hostname === "www.zhihu.com" && segments[0] === "pin"
      ? segments[1]
      : parsed.hostname === "www.zhihu.com" &&
          segments[0] === "video" &&
          segments[1] === "immersion" &&
          segments[2] === "feed"
        ? segments[3]
        : undefined;
  return pinId
    ? {
        apiPath: `/api/v4/pins/${pinId}`,
        contentField: "content_html",
        origin: "https://www.zhihu.com",
        titleField: "excerpt_title",
      }
    : null;
}

function buildZhihuDocument(payload: unknown, request: ZhihuArticleRequest): string {
  if (!isRecord(payload)) throw new Error("zhihu_invalid_response");
  const content = payload[request.contentField];
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("zhihu_empty_content");
  }
  const question = payload.question;
  const titleValue =
    request.titleField === "question" && isRecord(question)
      ? question.title
      : payload[request.titleField];
  const title = String(titleValue ?? "").split(" | ", 1)[0]!.trim();
  const eta = new Eta({ autoEscape: true, autoTrim: false });
  return eta.renderString(
    "<!doctype html><html><head><title><%= it.title %></title></head><body><article><%~ it.content %></article></body></html>",
    { content, title },
  );
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorCode: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function visibleCharacters(markdown: string): number {
  return markdown.replace(/\s+/g, "").length;
}

function assessArticle(article: ExtractedArticle, minVisibleCharacters: number): ArticleAssessment {
  const markdown = article.markdown.trim();
  const visible = visibleCharacters(markdown);
  const normalized = markdown.toLocaleLowerCase("en-US");
  if (ARTICLE_ERROR_MARKERS.some((marker) => normalized.includes(marker))) {
    return { reason: "error_marker", valid: false, visibleCharacters: visible };
  }
  if (!article.title.trim()) {
    return { reason: "missing_title", valid: false, visibleCharacters: visible };
  }
  if (visible < minVisibleCharacters) {
    return { reason: "short_content", valid: false, visibleCharacters: visible };
  }
  return { reason: null, valid: true, visibleCharacters: visible };
}

function withFallbackTitle(article: ExtractedArticle, fallbackTitle: string): ExtractedArticle {
  return article.title.trim() || !fallbackTitle.trim()
    ? article
    : { ...article, title: fallbackTitle.trim() };
}

function isWeChatArticleUrl(url: string): boolean {
  return new URL(url).hostname.toLowerCase() === "mp.weixin.qq.com";
}

async function ignorePlaywrightTimeout(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
}

async function urlFingerprint(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "article_archive_failed";
  return /^[a-z0-9_]+$/i.test(value) ? value : "article_archive_failed";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
