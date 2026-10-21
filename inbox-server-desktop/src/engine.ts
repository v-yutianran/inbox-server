import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { articleLooksUseful, copyLocalFile, extractArticle, extractHtml, renderArticleMarkdown, writeArticleFile, writeTextRecord } from "./archive.ts";
import { commitArchiveFile } from "./archive-git.ts";
import { collectBrowserSource, type BrowserContextLike, type BrowserSource } from "./browser-collect.ts";
import { fetchHtmlWithPlaywright } from "./playwright-fetch.ts";
import { openPersistentContext } from "./playwright-context.ts";
import { collectDida, collectGithubStars, collectTelegram, type CollectionResult } from "./collectors.ts";
import {
  RATE_POLICIES,
  createItemDedupeKey,
  formatFlomoContent,
  isHttpUrl,
  planQueueBatches,
  rateLimitInputs,
  sanitizeFilename,
  type DispatchItem,
  type ItemKind,
  type RatePolicy,
} from "./domain.ts";
import { mirrorToIma } from "./ima.ts";
import { importCloudExport, type ImportSummary } from "./import-cloud.ts";
import { formatCollectionNotification, notifyTelegram, sendSmtpMail } from "./notify.ts";
import {
  cookieHeader,
  credentialToStorageState,
  isBrowserPlatform,
  profileFile,
  readProfile,
  writeProfile,
  type StorageState,
} from "./profiles.ts";
import { browserPlatforms, overlaySettings, type BrowserPlatform } from "./settings.ts";
import { generateSmartTags } from "./smart-tags.ts";
import { type InboxStore, type JobRow, type PublicSettings, type Settings } from "./store.ts";
import { deliverJianguoyun } from "./webdav.ts";
import { buildZhihuDocument, resolveZhihuArticleRequest } from "./zhihu-article.ts";

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface Overview {
  generatedAt: string;
  dataDir: string;
  queues: ReturnType<InboxStore["queueCounts"]>;
  items: ReturnType<InboxStore["listItems"]>;
  syncJobs: ReturnType<InboxStore["listSyncJobs"]>;
  articleEvents: ReturnType<InboxStore["listArticleEvents"]>;
  cloudHistory: ReturnType<InboxStore["listCloudHistory"]>;
  settings: PublicSettings;
  profiles: Array<{ platform: BrowserPlatform; saved: boolean; cookieCount: number }>;
  scheduler: { enabled: boolean; intervalSeconds: number; nextRunAt: string | null };
}

export interface EngineOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  policies?: Record<ItemKind, RatePolicy>;
  minArticleCharacters?: number;
  /** 未设置时，HTTP 正文不够才调用 Playwright。传 null 表示不要启动浏览器。 */
  playwrightFetch?: ((url: string) => Promise<string>) | null;
  /** 测试注入。默认用本机 Playwright 和已保存的 storageState。 */
  openContext?: (profilePath: string) => Promise<BrowserContextLike>;
  /** Electron 登录窗口。没有窗口时请改走粘贴 cookie。 */
  loginHandler?: (platform: BrowserPlatform) => Promise<StorageState>;
}

export class InboxEngine {
  private syncing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextRunAt: string | null = null;
  private readonly store: InboxStore;
  private readonly dataDir: string;
  private readonly options: EngineOptions;

  constructor(
    store: InboxStore,
    dataDir: string,
    options: EngineOptions = {},
  ) {
    this.store = store;
    this.dataDir = dataDir;
    this.options = options;
  }

  now(): Date {
    return this.options.now?.() ?? new Date();
  }

  overview(): Overview {
    const settings = this.store.settings();
    return {
      generatedAt: this.now().toISOString(),
      dataDir: this.dataDir,
      queues: this.store.queueCounts(),
      items: this.store.listItems(),
      syncJobs: this.store.listSyncJobs(),
      articleEvents: this.store.listArticleEvents(),
      cloudHistory: this.store.listCloudHistory(),
      settings: this.store.publicSettings(),
      profiles: this.listProfiles(),
      scheduler: {
        enabled: settings.schedulerEnabled,
        intervalSeconds: settings.intervalSeconds,
        nextRunAt: this.nextRunAt,
      },
    };
  }

  updateSettings(patch: unknown): PublicSettings {
    const next = applySettingsPatch(this.store.settings(), patch);
    this.store.saveSettings(next);
    this.startScheduler();
    return this.store.publicSettings();
  }

  listProfiles(): Array<{ platform: BrowserPlatform; saved: boolean; cookieCount: number }> {
    return browserPlatforms.map((platform) => {
      const profile = readProfile(profileFile(this.dataDir, platform));
      return { platform, saved: profile !== null, cookieCount: profile?.cookies.length ?? 0 };
    });
  }

  async beginLogin(platform: string): Promise<{ platform: BrowserPlatform; cookies: number }> {
    if (!isBrowserPlatform(platform)) throw new CaptureError("不支持的登录平台");
    if (!this.options.loginHandler) {
      throw new CaptureError("当前进程没有登录窗口。请用 Electron 打开应用，或在设置里粘贴 cookie / storageState。");
    }
    const state = await this.options.loginHandler(platform);
    return this.storeProfile(platform, state);
  }

  saveCredential(platform: string, input: unknown): { platform: BrowserPlatform; cookies: number } {
    if (!isBrowserPlatform(platform)) throw new CaptureError("不支持的登录平台");
    try {
      return this.storeProfile(platform, credentialToStorageState(platform, input));
    } catch (error) {
      throw new CaptureError(error instanceof Error ? error.message : "登录凭据无效");
    }
  }

  importCloud(input: unknown): ImportSummary {
    return importCloudExport(this.store, input, this.now());
  }

  async capture(input: unknown): Promise<{ id: string; status: "done" | "deferred" | "dead" | "queued"; duplicate: boolean }> {
    const item = parseCapture(input, this.now());
    const dedupeKey = createItemDedupeKey(item);
    const existing = this.store.getItemByDedupe(dedupeKey);
    if (existing && existing.status !== "dead") {
      const status = existing.status === "done" || existing.status === "deferred" || existing.status === "queued"
        ? existing.status
        : "queued";
      return { id: existing.id, status, duplicate: true };
    }
    if (existing?.status === "dead") this.store.forgetDedupe(dedupeKey);
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    this.enqueue([{ id, dedupeKey, payload: item, createdAt }], "manual");
    await this.drain(20);
    const stored = this.store.listItems(1_000).find((row) => row.id === id);
    return {
      id,
      status: (stored?.status as "done" | "deferred" | "dead" | "queued") ?? "queued",
      duplicate: false,
    };
  }

  async sync(triggeredBy: string): Promise<{ id: string; status: string; stats: Record<string, unknown>; error: string | null }> {
    if (this.syncing) return { id: "", status: "busy", stats: {}, error: "已有同步在进行" };
    this.syncing = true;
    const id = randomUUID();
    const stats: Record<string, unknown> = {};
    const errors: string[] = [];
    this.store.startSyncJob(id, triggeredBy, this.now().toISOString());
    try {
      const settings = this.store.settings();
      if (settings.sources.dida.enabled && settings.sources.dida.accessToken) {
        await this.runCollector("dida", stats, errors, () => collectDida({
          token: settings.sources.dida.accessToken,
          state: this.store,
          fetcher: this.fetchImpl(),
        }));
      }
      if (settings.sources.github_stars.enabled && settings.sources.github_stars.token) {
        await this.runCollector("github_stars", stats, errors, () => collectGithubStars({
          token: settings.sources.github_stars.token,
          state: this.store,
          fetcher: this.fetchImpl(),
        }));
      }
      if (settings.sources.telegram.enabled && settings.sources.telegram.botToken) {
        await this.runCollector("telegram", stats, errors, () => collectTelegram({
          token: settings.sources.telegram.botToken,
          state: this.store,
          fetcher: this.fetchImpl(),
          stagingDir: join(this.dataDir, "staging"),
        }));
      }
      await this.syncBrowsers(settings, stats, errors);
      stats.drained = await this.drain(500);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "sync failed");
    } finally {
      this.syncing = false;
    }
    const error = errors.length > 0 ? errors.join("\n") : null;
    const status = error ? "failed" : "done";
    this.store.finishSyncJob(id, status, stats, this.now().toISOString(), error);
    return { id, status, stats, error };
  }

  async drain(limit = 200): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const job = this.store.leaseNext(this.now().toISOString());
      if (!job) break;
      await this.dispatch(job);
      processed += 1;
    }
    return processed;
  }

  startScheduler(): void {
    this.stopScheduler();
    const settings = this.store.settings();
    if (!settings.schedulerEnabled) {
      this.nextRunAt = null;
      return;
    }
    const intervalMs = settings.intervalSeconds * 1_000;
    this.nextRunAt = new Date(this.now().getTime() + intervalMs).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(this.now().getTime() + intervalMs).toISOString();
      void this.sync("schedule");
    }, intervalMs);
    this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runCollector(
    source: string,
    stats: Record<string, unknown>,
    errors: string[],
    collect: () => Promise<CollectionResult>,
  ): Promise<void> {
    try {
      const result = await collect();
      const published = this.enqueue(result.items.map((payload) => ({
        id: randomUUID(),
        dedupeKey: createItemDedupeKey(payload),
        payload,
        createdAt: this.now().toISOString(),
      })), source);
      for (const update of result.stateUpdates) this.store.putState(update.key, update.value, this.now().toISOString());
      if (result.cleanup) await result.cleanup();
      stats[source] = { ...result.meta, published: published.published, skipped: published.skipped };
      if (published.published > 0) {
        const collected = typeof result.meta.collected === "number" ? result.meta.collected : result.items.length;
        await this.notifyCollection(source, collected, published.published, stats);
      }
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : "collect failed"}`);
      stats[source] = { error: true };
    }
  }

  private enqueue(
    jobs: Array<{ id: string; dedupeKey: string; payload: DispatchItem; createdAt: string }>,
    source: string,
  ): { published: number; skipped: number } {
    planQueueBatches(jobs);
    return this.store.publishJobs(jobs.map((job) => ({ job, source })));
  }

  private async dispatch(job: JobRow): Promise<void> {
    const item = job.payload;
    const nowIso = this.now().toISOString();
    if (item.itemKind === "file" && !item.localPath) {
      this.store.killJob(job.id, job.dedupeKey, "cloud_object_not_local", nowIso);
      return;
    }
    await this.attachSmartTags(item);
    const localKey = `${job.dedupeKey}:local`;
    const remotes = remoteEffects(item, this.store.settings(), this.fetchImpl());
    const pending = remotes.filter((remote) => !this.store.effectDone(`${job.dedupeKey}:${remote.name}`));
    const localDone = this.store.effectDone(localKey);
    if (localDone && pending.length === 0) {
      this.store.completeJob(job.id, job.dedupeKey, null, nowIso);
      return;
    }
    if (!localDone) {
      const decision = this.store.consumeRateLimits(
        rateLimitInputs(item.itemKind, this.now(), this.policies()[item.itemKind]),
        this.now(),
      );
      if (!decision.allowed) {
        this.store.deferJob(job.id, job.dedupeKey, decision.retryAt ?? nowIso, "rate_limit", nowIso);
        return;
      }
    }
    try {
      const destinationPath = localDone ? null : await this.writeLocal(job);
      if (!localDone) this.store.markEffect(localKey, job.id, "local", "done", nowIso);
      for (const remote of pending) {
        await remote.run();
        this.store.markEffect(`${job.dedupeKey}:${remote.name}`, job.id, remote.name, "done", nowIso);
      }
      if (item.itemKind === "link" && this.store.settings().archiveEnabled) this.enqueueArticle(item);
      this.store.completeJob(job.id, job.dedupeKey, destinationPath, nowIso);
    } catch (error) {
      const message = error instanceof Error ? error.message : "dispatch failed";
      if (message === "quota") {
        this.store.deferJob(job.id, job.dedupeKey, new Date(this.now().getTime() + 60_000).toISOString(), "quota", nowIso);
        return;
      }
      if (job.attempts >= 3) this.store.killJob(job.id, job.dedupeKey, message, nowIso);
      else this.store.deferJob(job.id, job.dedupeKey, new Date(this.now().getTime() + 30_000).toISOString(), message, nowIso);
    }
  }

  private enqueueArticle(item: Extract<DispatchItem, { itemKind: "link" }>): void {
    const article: DispatchItem = {
      itemKind: "article",
      requestedAt: this.now().toISOString(),
      tags: item.tags,
      title: item.title,
      url: item.url,
    };
    this.enqueue([{
      id: randomUUID(),
      dedupeKey: createItemDedupeKey(article),
      payload: article,
      createdAt: this.now().toISOString(),
    }], "archive");
  }

  private async writeLocal(job: JobRow): Promise<string> {
    const item = job.payload;
    const stamp = this.now().toISOString();
    if (item.itemKind === "link") {
      const body = renderArticleMarkdown({
        archivedAt: stamp,
        author: "",
        markdown: `[${item.title || item.url}](${item.url})`,
        sourceUrl: item.url,
        tags: item.tags ?? [],
        title: item.title || item.url,
      });
      return writeTextRecord(join(this.dataDir, "library", "links"), job.dedupeKey.slice(-16), body);
    }
    if (item.itemKind === "text") {
      const body = renderArticleMarkdown({
        archivedAt: stamp,
        author: "",
        markdown: item.content,
        sourceUrl: "",
        tags: item.tags ?? [],
        title: item.content.slice(0, 40),
      });
      return writeTextRecord(join(this.dataDir, "library", "notes"), job.dedupeKey.slice(-16), body);
    }
    if (item.itemKind === "file") {
      if (!item.localPath || !existsSync(item.localPath)) throw new Error("local file is missing");
      return copyLocalFile(item.localPath, join(this.dataDir, "library", "files"), sanitizeFilename(item.remoteName));
    }
    return this.archiveArticle(item);
  }

  private async archiveArticle(item: Extract<DispatchItem, { itemKind: "article" }>): Promise<string> {
    const html = await this.loadArticleHtml(item.url, item.title);
    const extracted = await extractArticle(html, item.url);
    const title = item.title?.trim() || extracted.title || "untitled";
    const article = { title, markdown: extracted.markdown };
    const assessment = articleLooksUseful(article, this.options.minArticleCharacters ?? 200);
    const fingerprint = createItemDedupeKey(item);
    if (!assessment.ok) {
      this.store.recordArticleEvent({
        filename: null,
        occurredAt: this.now().toISOString(),
        reason: assessment.reason,
        sourceUrl: item.url,
        status: "skipped",
        title,
        urlFingerprint: fingerprint,
      });
      return "";
    }
    const content = renderArticleMarkdown({
      archivedAt: this.now().toISOString(),
      author: "",
      markdown: article.markdown,
      sourceUrl: item.url,
      tags: item.tags ?? [],
      title,
    });
    const directory = join(this.dataDir, "archive", "sources", "article");
    const path = writeArticleFile(directory, title, this.now(), content, item.url);
    this.store.recordArticleEvent({
      filename: path,
      occurredAt: this.now().toISOString(),
      reason: null,
      sourceUrl: item.url,
      status: "committed",
      title,
      urlFingerprint: fingerprint,
    });
    if (path && this.store.settings().archiveGit) {
      const root = join(this.dataDir, "archive");
      await commitArchiveFile(root, relative(root, path));
    }
    if (path) await this.mirrorArticle(path, content, item.url);
    return path;
  }

  private async loadArticleHtml(url: string, preferredTitle: string | undefined): Promise<string> {
    const zhihuHtml = await this.loadZhihuHtml(url);
    if (zhihuHtml && this.htmlIsUseful(zhihuHtml, preferredTitle)) return zhihuHtml;
    let httpHtml = "";
    try {
      const response = await this.fetchImpl()(url, {
        headers: { accept: "text/html", "user-agent": "inbox-server-desktop" },
      });
      if (response.ok) httpHtml = await response.text();
    } catch {
      httpHtml = "";
    }
    if (httpHtml && this.htmlIsUseful(httpHtml, preferredTitle)) return httpHtml;
    const fallback = this.options.playwrightFetch === undefined ? fetchHtmlWithPlaywright : this.options.playwrightFetch;
    if (!fallback) {
      if (!httpHtml) throw new Error(`article fetch failed: ${url}`);
      return httpHtml;
    }
    try {
      return await fallback(url);
    } catch (error) {
      if (httpHtml) return httpHtml;
      throw error;
    }
  }

  private htmlIsUseful(html: string, preferredTitle: string | undefined): boolean {
    const extracted = extractHtml(html);
    return articleLooksUseful({
      markdown: extracted.markdown,
      title: preferredTitle?.trim() || extracted.title,
    }, this.options.minArticleCharacters ?? 200).ok;
  }

  private policies(): Record<ItemKind, RatePolicy> {
    return this.options.policies ?? RATE_POLICIES;
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async syncBrowsers(settings: Settings, stats: Record<string, unknown>, errors: string[]): Promise<void> {
    const sources: Array<{ name: BrowserSource; enabled: boolean; config: Record<string, unknown>; platform: BrowserPlatform }> = [
      { name: "zhihu", enabled: settings.sources.zhihu.enabled, config: { collection_id: settings.sources.zhihu.collectionId }, platform: "zhihu" },
      { name: "bilibili", enabled: settings.sources.bilibili.enabled, config: { media_id: settings.sources.bilibili.mediaId }, platform: "bilibili" },
      { name: "bilibili_toview", enabled: settings.sources.bilibili_toview.enabled, config: {}, platform: "bilibili" },
      { name: "inoreader", enabled: settings.sources.inoreader.enabled, config: {}, platform: "inoreader" },
      { name: "youtube", enabled: settings.sources.youtube.enabled, config: {}, platform: "youtube" },
      { name: "x_bookmarks", enabled: settings.sources.x_bookmarks.enabled, config: {}, platform: "x" },
      { name: "x_likes", enabled: settings.sources.x_likes.enabled, config: { username: settings.sources.x_likes.username }, platform: "x" },
    ];
    for (const source of sources) {
      if (!source.enabled) continue;
      await this.runCollector(source.name, stats, errors, async () => {
        const file = profileFile(this.dataDir, source.platform);
        if (!existsSync(file)) throw new Error(`${source.platform} 还没有登录，请先在应用里登录`);
        const open = this.options.openContext ?? openPersistentContext;
        const context = await open(file);
        try {
          return await collectBrowserSource(source.name, source.config, context, (key) => this.knownKeys(key));
        } finally {
          await context.close();
        }
      });
    }
  }

  private knownKeys(source: string): ReadonlySet<string> {
    const value = this.store.getState(`baseline:${source}`);
    if (!isRecord(value) || !Array.isArray(value.knownKeys)) return new Set();
    return new Set(value.knownKeys.filter((item): item is string => typeof item === "string"));
  }

  private async notifyCollection(source: string, collected: number, published: number, stats: Record<string, unknown>): Promise<void> {
    const settings = this.store.settings().notification;
    const message = formatCollectionNotification({ collected, published, source });
    try {
      if (settings.notifyToken && settings.telegramChatId) {
        await notifyTelegram(this.fetchImpl(), settings.notifyToken, settings.telegramChatId, message);
      }
      if (settings.emailEnabled && settings.smtpHost && settings.smtpUser && settings.smtpPass && settings.emailFrom && settings.emailTo) {
        await sendSmtpMail({
          body: message,
          from: settings.emailFrom,
          host: settings.smtpHost,
          password: settings.smtpPass,
          port: settings.smtpPort,
          recipient: settings.emailTo,
          subject: message,
          user: settings.smtpUser,
        });
      }
    } catch (error) {
      stats[`${source}:notify`] = error instanceof Error ? error.message : "notify failed";
    }
  }

  private async attachSmartTags(item: DispatchItem): Promise<void> {
    if (item.itemKind !== "text" || (item.tags && item.tags.length > 0)) return;
    const llm = this.store.settings().llm;
    if (!llm.apiKey) return;
    const tags = await generateSmartTags({
      apiKey: llm.apiKey,
      content: item.content,
      fetcher: this.fetchImpl(),
      model: llm.model,
    });
    if (tags.length > 0) item.tags = tags;
  }

  private async mirrorArticle(path: string, content: string, sourceUrl: string): Promise<void> {
    const ima = this.store.settings().ima;
    if (!ima.enabled || !ima.apiKey || !ima.clientId || !ima.knowledgeBaseName) return;
    const webHeaders = ima.webCookie || ima.webImaCookie || ima.webBkn
      ? { cookie: ima.webCookie, "x-ima-bkn": ima.webBkn, "x-ima-cookie": ima.webImaCookie }
      : undefined;
    await mirrorToIma({
      apiKey: ima.apiKey,
      clientId: ima.clientId,
      content,
      fetcher: this.fetchImpl(),
      filename: basename(path),
      knowledgeBaseName: ima.knowledgeBaseName,
      now: () => this.now(),
      sourceUrl,
      stateGet: (key) => this.store.getState(key),
      statePut: (key, value) => this.store.putState(key, value, this.now().toISOString()),
      webHeaders,
      webKnowledgeBaseId: ima.webKnowledgeBaseId || undefined,
    });
  }

  private async loadZhihuHtml(url: string): Promise<string | null> {
    let request: ReturnType<typeof resolveZhihuArticleRequest>;
    try {
      request = resolveZhihuArticleRequest(url);
    } catch {
      return null;
    }
    if (!request) return null;
    const profile = readProfile(profileFile(this.dataDir, "zhihu"));
    if (!profile) return null;
    const cookie = cookieHeader(profile, "zhihu.com");
    if (!cookie) return null;
    try {
      const response = await this.fetchImpl()(`${request.origin}${request.apiPath}`, {
        headers: { accept: "application/json", cookie, referer: url },
      });
      if (!response.ok) return null;
      return buildZhihuDocument(await response.json(), request);
    } catch {
      return null;
    }
  }

  private storeProfile(platform: BrowserPlatform, state: StorageState): { platform: BrowserPlatform; cookies: number } {
    writeProfile(profileFile(this.dataDir, platform), state);
    return { platform, cookies: state.cookies.length };
  }
}

export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  try {
    return overlaySettings(current, patch);
  } catch (error) {
    throw new CaptureError(error instanceof Error ? error.message : "设置格式无效");
  }
}

function parseCapture(input: unknown, now: Date): DispatchItem {
  if (!isRecord(input)) throw new CaptureError("收录内容无效");
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0) : undefined;
  if (input.itemKind === "link" || input.itemKind === "article") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!isHttpUrl(url)) throw new CaptureError("需要有效的 http(s) 链接");
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
    if (input.itemKind === "article") {
      return { itemKind: "article", requestedAt: now.toISOString(), tags, title, url };
    }
    return { itemKind: "link", tags, title, url };
  }
  if (input.itemKind === "text") {
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!content) throw new CaptureError("文本不能为空");
    return { itemKind: "text", content, tags };
  }
  if (input.itemKind === "file") {
    const localPath = typeof input.localPath === "string" ? input.localPath.trim() : "";
    const remoteName = sanitizeFilename(typeof input.remoteName === "string" ? input.remoteName : localPath);
    if (!localPath || !existsSync(localPath)) throw new CaptureError("本机文件不存在");
    return { itemKind: "file", localPath, remoteName };
  }
  throw new CaptureError("不支持的内容类型");
}

function remoteEffects(
  item: DispatchItem,
  settings: Settings,
  fetchImpl: typeof fetch,
): Array<{ name: string; run: () => Promise<void> }> {
  const effects: Array<{ name: string; run: () => Promise<void> }> = [];
  if (item.itemKind === "link" && settings.forward.cuboxUrl) {
    effects.push({ name: "cubox", run: () => postCubox(fetchImpl, settings.forward.cuboxUrl, item) });
  }
  if (item.itemKind === "text" && settings.forward.flomoWebhook) {
    effects.push({ name: "flomo", run: () => postFlomo(fetchImpl, settings.forward.flomoWebhook, item) });
  }
  if (item.itemKind === "file" && item.localPath && settings.jianguoyun.enabled && settings.jianguoyun.user && settings.jianguoyun.password) {
    const localPath = item.localPath;
    effects.push({
      name: "jianguoyun",
      run: () => deliverJianguoyun({
        baseUrl: settings.jianguoyun.baseUrl,
        content: new Uint8Array(readFileSync(localPath)),
        fetcher: fetchImpl,
        password: settings.jianguoyun.password,
        remoteName: item.remoteName,
        user: settings.jianguoyun.user,
      }),
    });
  }
  return effects;
}

async function postCubox(fetchImpl: typeof fetch, url: string, item: Extract<DispatchItem, { itemKind: "link" }>): Promise<void> {
  const response = await fetchImpl(url, {
    body: JSON.stringify({ content: item.url, tags: item.tags ?? [], title: item.title || item.url, type: "url" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await readJson(response);
  if (isRecord(body) && body.code === -3030) throw new Error("quota");
  if (isRecord(body) && body.code === 200) return;
  if (response.ok && body === null) return;
  throw new Error(`cubox failed: ${response.status}`);
}

async function postFlomo(fetchImpl: typeof fetch, url: string, item: Extract<DispatchItem, { itemKind: "text" }>): Promise<void> {
  const response = await fetchImpl(url, {
    body: JSON.stringify({ content: formatFlomoContent(item.content, item.tags ?? []), content_type: "markdown" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await readJson(response);
  if (isRecord(body) && body.code === 0) return;
  throw new Error(`flomo failed: ${response.status}`);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
