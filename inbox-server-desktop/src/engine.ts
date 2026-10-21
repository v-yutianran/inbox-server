import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { articleLooksUseful, copyLocalFile, extractHtml, renderArticleMarkdown, writeArticleFile, writeTextRecord } from "./archive.ts";
import { fetchHtmlWithPlaywright } from "./playwright-fetch.ts";
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
import { importCloudExport, type ImportSummary } from "./import-cloud.ts";
import { mergeSettings, type InboxStore, type JobRow, type PublicSettings, type Settings } from "./store.ts";

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
  scheduler: { enabled: boolean; intervalSeconds: number; nextRunAt: string | null };
}

export interface EngineOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  policies?: Record<ItemKind, RatePolicy>;
  minArticleCharacters?: number;
  /** 未设置时，HTTP 正文不够才调用 Playwright。传 null 表示不要启动浏览器。 */
  playwrightFetch?: ((url: string) => Promise<string>) | null;
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
    const localKey = `${job.dedupeKey}:local`;
    const remote = remoteDestination(item, this.store.settings());
    const remoteKey = remote ? `${job.dedupeKey}:${remote.name}` : null;
    const localDone = this.store.effectDone(localKey);
    const remoteDone = remoteKey ? this.store.effectDone(remoteKey) : true;
    if (localDone && remoteDone) {
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
      if (remote && remoteKey && !remoteDone) await this.forward(remote, item);
      if (remote && remoteKey) this.store.markEffect(remoteKey, job.id, remote.name, "done", nowIso);
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
    const extracted = extractHtml(html);
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
    const path = writeArticleFile(join(this.dataDir, "archive", "sources", "article"), title, this.now(), content, item.url);
    this.store.recordArticleEvent({
      filename: path,
      occurredAt: this.now().toISOString(),
      reason: null,
      sourceUrl: item.url,
      status: "committed",
      title,
      urlFingerprint: fingerprint,
    });
    return path;
  }

  private async forward(
    remote: { name: "cubox" | "flomo"; url: string },
    item: DispatchItem,
  ): Promise<void> {
    if (remote.name === "cubox" && item.itemKind === "link") {
      const response = await this.fetchImpl()(remote.url, {
        body: JSON.stringify({
          content: item.url,
          tags: item.tags ?? [],
          title: item.title || item.url,
          type: "url",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson(response);
      if (isRecord(body) && body.code === -3030) throw new Error("quota");
      if (isRecord(body) && body.code === 200) return;
      if (response.ok && body === null) return;
      throw new Error(`cubox failed: ${response.status}`);
    }
    if (remote.name === "flomo" && item.itemKind === "text") {
      const response = await this.fetchImpl()(remote.url, {
        body: JSON.stringify({
          content: formatFlomoContent(item.content, item.tags ?? []),
          content_type: "markdown",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson(response);
      if (isRecord(body) && body.code === 0) return;
      throw new Error(`flomo failed: ${response.status}`);
    }
  }

  private async loadArticleHtml(url: string, preferredTitle: string | undefined): Promise<string> {
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
}

export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) throw new CaptureError("设置格式无效");
  const next = mergeSettings(current);
  next.sources = structuredClone(current.sources);
  next.forward = { ...current.forward };
  if (typeof patch.archiveEnabled === "boolean") next.archiveEnabled = patch.archiveEnabled;
  if (typeof patch.schedulerEnabled === "boolean") next.schedulerEnabled = patch.schedulerEnabled;
  if (typeof patch.intervalSeconds === "number" && patch.intervalSeconds >= 30 && patch.intervalSeconds <= 86_400) {
    next.intervalSeconds = Math.floor(patch.intervalSeconds);
  }
  const sources = isRecord(patch.sources) ? patch.sources : {};
  assignSource(next, sources, "dida", "accessToken");
  assignSource(next, sources, "github_stars", "token");
  assignSource(next, sources, "telegram", "botToken");
  if (isRecord(patch.forward)) {
    if (patch.forward.cuboxUrl === null) next.forward.cuboxUrl = "";
    else if (typeof patch.forward.cuboxUrl === "string" && patch.forward.cuboxUrl.length > 0) {
      if (!isHttpUrl(patch.forward.cuboxUrl)) throw new CaptureError("Cubox 地址必须是 http(s) URL");
      next.forward.cuboxUrl = patch.forward.cuboxUrl;
    }
    if (patch.forward.flomoWebhook === null) next.forward.flomoWebhook = "";
    else if (typeof patch.forward.flomoWebhook === "string" && patch.forward.flomoWebhook.length > 0) {
      if (!isHttpUrl(patch.forward.flomoWebhook)) throw new CaptureError("flomo 地址必须是 http(s) URL");
      next.forward.flomoWebhook = patch.forward.flomoWebhook;
    }
  }
  return next;
}

function assignSource(
  next: Settings,
  sources: Record<string, unknown>,
  name: "dida" | "github_stars" | "telegram",
  secretKey: "accessToken" | "token" | "botToken",
): void {
  const incoming = sources[name];
  if (!isRecord(incoming)) return;
  if (typeof incoming.enabled === "boolean") next.sources[name].enabled = incoming.enabled;
  const secret = incoming[secretKey];
  if (secret === null) {
    if (secretKey === "accessToken") next.sources.dida.accessToken = "";
    if (secretKey === "token") next.sources.github_stars.token = "";
    if (secretKey === "botToken") next.sources.telegram.botToken = "";
  } else if (typeof secret === "string" && secret.length > 0) {
    if (secretKey === "accessToken") next.sources.dida.accessToken = secret;
    if (secretKey === "token") next.sources.github_stars.token = secret;
    if (secretKey === "botToken") next.sources.telegram.botToken = secret;
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

function remoteDestination(item: DispatchItem, settings: Settings): { name: "cubox" | "flomo"; url: string } | null {
  if (item.itemKind === "link" && settings.forward.cuboxUrl) return { name: "cubox", url: settings.forward.cuboxUrl };
  if (item.itemKind === "text" && settings.forward.flomoWebhook) return { name: "flomo", url: settings.forward.flomoWebhook };
  return null;
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
