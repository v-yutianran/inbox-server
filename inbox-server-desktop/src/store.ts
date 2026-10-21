import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import type { DispatchItem, ItemKind, RateLimitInput } from "./domain.ts";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  readSettingsFile,
  toPublicSettings,
  writeSettingsFile,
  type PublicSettings,
  type Settings,
} from "./settings.ts";

export type { PublicSettings, Settings };
export { mergeSettings };

export interface ItemRow {
  id: string;
  dedupeKey: string;
  itemKind: ItemKind;
  title: string | null;
  url: string | null;
  content: string | null;
  tags: string[];
  source: string;
  status: string;
  destinationPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface JobRow {
  id: string;
  dedupeKey: string;
  payload: DispatchItem;
  status: string;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  createdAt: string;
}

export interface SyncJobRow {
  id: string;
  triggeredBy: string;
  status: string;
  stats: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface ArticleEventRow {
  id: number;
  sourceUrl: string;
  urlFingerprint: string;
  title: string;
  status: string;
  reason: string | null;
  filename: string | null;
  occurredAt: string;
}

export interface CloudHistoryRow {
  dedupeKey: string;
  jobId: string;
  kind: string;
  itemKind: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface QueueCounts {
  pending: number;
  deferred: number;
  done: number;
  dead: number;
}

export class RateLimitedError extends Error {
  readonly retryAt: string;

  constructor(retryAt: string) {
    super("rate limit");
    this.name = "RateLimitedError";
    this.retryAt = retryAt;
  }
}

type SqlRow = Record<string, unknown>;

export class InboxStore {
  readonly db: DatabaseSync;
  readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    const fromFile = readSettingsFile(filename);
    if (fromFile) this.saveSettings(fromFile);
    else writeSettingsFile(filename, this.settings());
    if (filename !== ":memory:") chmodSync(filename, 0o600);
  }

  close(): void {
    this.db.close();
  }

  settings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as SqlRow | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    return mergeSettings(JSON.parse(String(row.value)) as Partial<Settings>);
  }

  publicSettings(): PublicSettings {
    return toPublicSettings(this.settings());
  }

  saveSettings(next: Settings): void {
    this.db.prepare(
      `INSERT INTO settings (key, value) VALUES ('app', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify(next));
    writeSettingsFile(this.filename, next);
  }

  getState(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM worker_state WHERE key = ?").get(key) as SqlRow | undefined;
    return row ? JSON.parse(String(row.value)) : null;
  }

  putState(key: string, value: unknown, updatedAt: string): void {
    this.db.prepare(
      `INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), updatedAt);
  }

  publishJobs(jobs: readonly { job: { id: string; dedupeKey: string; payload: DispatchItem; createdAt: string }; source: string }[]): { published: number; skipped: number } {
    const insertJob = this.db.prepare(
      `INSERT OR IGNORE INTO jobs
        (id, dedupe_key, payload, status, attempts, available_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, NULL, ?, ?)`,
    );
    const insertItem = this.db.prepare(
      `INSERT OR IGNORE INTO items
        (id, dedupe_key, item_kind, title, url, content, tags, source, status, destination_path, error, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, ?, ?, NULL)`,
    );
    let published = 0;
    this.transaction(() => {
      for (const entry of jobs) {
        const payload = entry.job.payload;
        const result = insertJob.run(
          entry.job.id,
          entry.job.dedupeKey,
          JSON.stringify(payload),
          entry.job.createdAt,
          entry.job.createdAt,
          entry.job.createdAt,
        );
        if (Number(result.changes) === 0) continue;
        published += 1;
        const fields = itemFields(payload);
        insertItem.run(
          entry.job.id,
          entry.job.dedupeKey,
          payload.itemKind,
          fields.title,
          fields.url,
          fields.content,
          JSON.stringify(payload.itemKind === "file" ? [] : payload.tags ?? []),
          entry.source,
          entry.job.createdAt,
          entry.job.createdAt,
        );
      }
    });
    return { published, skipped: jobs.length - published };
  }

  leaseNext(nowIso: string): JobRow | null {
    const selected = this.db.prepare(
      `SELECT id FROM jobs
       WHERE status IN ('queued', 'deferred') AND available_at <= ?
       ORDER BY available_at, created_at
       LIMIT 1`,
    ).get(nowIso) as SqlRow | undefined;
    if (!selected) return null;
    this.db.prepare(
      `UPDATE jobs
       SET status = 'leased', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'deferred')`,
    ).run(nowIso, String(selected.id));
    return this.readJob(String(selected.id));
  }

  readJob(id: string): JobRow | null {
    const row = this.db.prepare(
      `SELECT id, dedupe_key, payload, status, attempts, available_at, last_error, created_at
       FROM jobs WHERE id = ?`,
    ).get(id) as SqlRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      dedupeKey: String(row.dedupe_key),
      payload: JSON.parse(String(row.payload)) as DispatchItem,
      status: String(row.status),
      attempts: Number(row.attempts),
      availableAt: String(row.available_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at),
    };
  }

  completeJob(id: string, dedupeKey: string, destinationPath: string | null, nowIso: string): void {
    this.transaction(() => {
      this.db.prepare(
        `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`,
      ).run(nowIso, id);
      this.db.prepare(
        `UPDATE items
         SET status = 'done', destination_path = COALESCE(?, destination_path), error = NULL,
             updated_at = ?, finished_at = ?
         WHERE dedupe_key = ?`,
      ).run(destinationPath, nowIso, nowIso, dedupeKey);
    });
  }

  deferJob(id: string, dedupeKey: string, availableAt: string, reason: string, nowIso: string): void {
    this.transaction(() => {
      this.db.prepare(
        `UPDATE jobs SET status = 'deferred', available_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(availableAt, reason, nowIso, id);
      this.db.prepare(
        `UPDATE items SET status = 'deferred', error = ?, updated_at = ? WHERE dedupe_key = ?`,
      ).run(reason, nowIso, dedupeKey);
    });
  }

  killJob(id: string, dedupeKey: string, reason: string, nowIso: string): void {
    this.transaction(() => {
      this.db.prepare(
        `UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(reason, nowIso, id);
      this.db.prepare(
        `UPDATE items SET status = 'dead', error = ?, updated_at = ?, finished_at = ? WHERE dedupe_key = ?`,
      ).run(reason, nowIso, nowIso, dedupeKey);
    });
  }

  effectDone(effectKey: string): boolean {
    const row = this.db.prepare(
      "SELECT status FROM effects WHERE effect_key = ? AND status = 'done'",
    ).get(effectKey) as SqlRow | undefined;
    return row !== undefined;
  }

  markEffect(effectKey: string, jobId: string, destination: string, status: string, nowIso: string): void {
    this.db.prepare(
      `INSERT INTO effects (effect_key, job_id, destination, status, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(effect_key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    ).run(effectKey, jobId, destination, status, nowIso);
  }

  consumeRateLimits(inputs: readonly RateLimitInput[], now: Date): { allowed: boolean; retryAt?: string } {
    if (inputs.length === 0) return { allowed: true };
    const select = this.db.prepare("SELECT count, expires_at FROM rate_buckets WHERE bucket_key = ?");
    const upsert = this.db.prepare(
      `INSERT INTO rate_buckets (bucket_key, count, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at`,
    );
    try {
      this.transaction(() => {
        for (const input of inputs) {
          const key = `${input.scope}:${input.bucketKey}`;
          const expiresAt = new Date(now.getTime() + input.windowSeconds * 1_000).toISOString();
          const row = select.get(key) as SqlRow | undefined;
          if (!row || Date.parse(String(row.expires_at)) <= now.getTime()) {
            upsert.run(key, 1, expiresAt);
            continue;
          }
          const count = Number(row.count);
          if (count >= input.limit) throw new RateLimitedError(String(row.expires_at));
          upsert.run(key, count + 1, String(row.expires_at));
        }
      });
      return { allowed: true };
    } catch (error) {
      if (error instanceof RateLimitedError) return { allowed: false, retryAt: error.retryAt };
      throw error;
    }
  }

  queueCounts(): Record<ItemKind, QueueCounts> {
    const kinds: ItemKind[] = ["link", "text", "file", "article"];
    const counts = {} as Record<ItemKind, QueueCounts>;
    for (const kind of kinds) {
      counts[kind] = { pending: 0, deferred: 0, done: 0, dead: 0 };
    }
    const rows = this.db.prepare(
      `SELECT item_kind, status, COUNT(*) AS n FROM items GROUP BY item_kind, status`,
    ).all() as SqlRow[];
    for (const row of rows) {
      const kind = String(row.item_kind) as ItemKind;
      const bucket = counts[kind];
      if (!bucket) continue;
      const status = String(row.status);
      const n = Number(row.n);
      if (status === "queued" || status === "leased") bucket.pending += n;
      else if (status === "deferred") bucket.deferred += n;
      else if (status === "done" || status === "skipped") bucket.done += n;
      else if (status === "dead" || status === "failed") bucket.dead += n;
    }
    return counts;
  }

  getItemByDedupe(dedupeKey: string): ItemRow | null {
    const row = this.db.prepare(
      `SELECT id, dedupe_key, item_kind, title, url, content, tags, source, status,
              destination_path, error, created_at, updated_at, finished_at
       FROM items WHERE dedupe_key = ?`,
    ).get(dedupeKey) as SqlRow | undefined;
    return row ? mapItem(row) : null;
  }

  forgetDedupe(dedupeKey: string): void {
    this.transaction(() => {
      this.db.prepare(
        "DELETE FROM effects WHERE job_id IN (SELECT id FROM jobs WHERE dedupe_key = ?)",
      ).run(dedupeKey);
      this.db.prepare("DELETE FROM jobs WHERE dedupe_key = ?").run(dedupeKey);
      this.db.prepare("DELETE FROM items WHERE dedupe_key = ?").run(dedupeKey);
    });
  }

  listItems(limit = 200): ItemRow[] {
    const rows = this.db.prepare(
      `SELECT id, dedupe_key, item_kind, title, url, content, tags, source, status,
              destination_path, error, created_at, updated_at, finished_at
       FROM items ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as SqlRow[];
    return rows.map(mapItem);
  }

  listSyncJobs(limit = 20): SyncJobRow[] {
    const rows = this.db.prepare(
      `SELECT id, triggered_by, status, stats, started_at, finished_at, error
       FROM sync_jobs ORDER BY started_at DESC LIMIT ?`,
    ).all(limit) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      triggeredBy: String(row.triggered_by),
      status: String(row.status),
      stats: JSON.parse(String(row.stats)) as Record<string, unknown>,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      error: row.error === null ? null : String(row.error),
    }));
  }

  startSyncJob(id: string, triggeredBy: string, startedAt: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO sync_jobs (id, triggered_by, status, stats, started_at, finished_at, error)
       VALUES (?, ?, 'running', '{}', ?, NULL, NULL)`,
    ).run(id, triggeredBy, startedAt);
  }

  finishSyncJob(id: string, status: string, stats: unknown, finishedAt: string, error: string | null): void {
    this.db.prepare(
      `UPDATE sync_jobs SET status = ?, stats = ?, finished_at = ?, error = ? WHERE id = ?`,
    ).run(status, JSON.stringify(stats), finishedAt, error, id);
  }

  recordArticleEvent(event: Omit<ArticleEventRow, "id">): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO article_events
        (source_url, url_fingerprint, title, status, reason, filename, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.sourceUrl, event.urlFingerprint, event.title, event.status, event.reason, event.filename, event.occurredAt);
    return Number(result.changes) > 0;
  }

  listArticleEvents(limit = 50): ArticleEventRow[] {
    const rows = this.db.prepare(
      `SELECT id, source_url, url_fingerprint, title, status, reason, filename, occurred_at
       FROM article_events ORDER BY occurred_at DESC LIMIT ?`,
    ).all(limit) as SqlRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      sourceUrl: String(row.source_url),
      urlFingerprint: String(row.url_fingerprint),
      title: String(row.title),
      status: String(row.status),
      reason: row.reason === null ? null : String(row.reason),
      filename: row.filename === null ? null : String(row.filename),
      occurredAt: String(row.occurred_at),
    }));
  }

  upsertCloudHistory(row: CloudHistoryRow): void {
    this.db.prepare(
      `INSERT INTO cloud_history
        (dedupe_key, job_id, kind, item_kind, status, error_message, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         status = excluded.status,
         error_message = excluded.error_message,
         finished_at = excluded.finished_at`,
    ).run(row.dedupeKey, row.jobId, row.kind, row.itemKind, row.status, row.errorMessage, row.createdAt, row.finishedAt);
  }

  listCloudHistory(limit = 100): CloudHistoryRow[] {
    const rows = this.db.prepare(
      `SELECT dedupe_key, job_id, kind, item_kind, status, error_message, created_at, finished_at
       FROM cloud_history ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as SqlRow[];
    return rows.map((row) => ({
      dedupeKey: String(row.dedupe_key),
      jobId: String(row.job_id),
      kind: String(row.kind),
      itemKind: row.item_kind === null ? null : String(row.item_kind),
      status: String(row.status),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      createdAt: String(row.created_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
  }

  recordImport(id: string, importedAt: string, summary: unknown): void {
    this.db.prepare("INSERT INTO import_runs (id, imported_at, summary) VALUES (?, ?, ?)").run(
      id,
      importedAt,
      JSON.stringify(summary),
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(status, available_at, created_at);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        item_kind TEXT NOT NULL,
        title TEXT,
        url TEXT,
        content TEXT,
        tags TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        destination_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS effects (
        effect_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_buckets (
        bucket_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_jobs (
        id TEXT PRIMARY KEY,
        triggered_by TEXT NOT NULL,
        status TEXT NOT NULL,
        stats TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS article_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_url TEXT NOT NULL,
        url_fingerprint TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        filename TEXT,
        occurred_at TEXT NOT NULL,
        UNIQUE (url_fingerprint, status, occurred_at)
      );
      CREATE TABLE IF NOT EXISTS cloud_history (
        dedupe_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_kind TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS import_runs (
        id TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL,
        summary TEXT NOT NULL
      );
    `);
    const existing = this.db.prepare("SELECT 1 AS ok FROM settings WHERE key = 'app'").get();
    if (!existing) {
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify(DEFAULT_SETTINGS));
    }
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function itemFields(payload: DispatchItem): { title: string | null; url: string | null; content: string | null } {
  switch (payload.itemKind) {
    case "link":
    case "article":
      return { title: payload.title ?? null, url: payload.url, content: null };
    case "text":
      return { title: null, url: null, content: payload.content };
    case "file":
      return { title: payload.remoteName, url: null, content: payload.localPath ?? payload.objectKey ?? null };
  }
}

function mapItem(row: SqlRow): ItemRow {
  return {
    id: String(row.id),
    dedupeKey: String(row.dedupe_key),
    itemKind: String(row.item_kind) as ItemKind,
    title: row.title === null ? null : String(row.title),
    url: row.url === null ? null : String(row.url),
    content: row.content === null ? null : String(row.content),
    tags: JSON.parse(String(row.tags)) as string[],
    source: String(row.source),
    status: String(row.status),
    destinationPath: row.destination_path === null ? null : String(row.destination_path),
    error: row.error === null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}
