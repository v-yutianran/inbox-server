import type { QueueJob } from "@inbox/domain";
import { describe, expect, it, vi } from "vitest";

import { decryptJson, encryptJson } from "../src/credential-crypto.js";
import {
  MissingCookieFieldError,
  UnsupportedCookiePlatformError,
} from "../src/control-plane.js";
import { createPostgresControlPlaneDataService } from "../src/control-plane-postgres-data.js";
import type { PostgresPool } from "../src/queue-inbox-postgres.js";

const encryptionKey = Buffer.alloc(32, 5).toString("base64");
const timestamp = "2030-01-01T00:00:00.000Z";

describe("PostgreSQL control-plane data", () => {
  it("reads and writes JSON state with schema-qualified parameterized SQL", async () => {
    const database = scriptedPool((sql) =>
      sql.includes("SELECT value") ? [{ value: '{"ready":true}' }] : [],
    );
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      now: () => new Date(timestamp),
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });

    await expect(service.getState("state:key")).resolves.toEqual({ ready: true });
    await service.putState("state:key", { ready: false });
    expect(database.calls[0]).toMatchObject({
      sql: expect.stringContaining("FROM inbox_server.worker_state WHERE key = $1"),
      values: ["state:key"],
    });
    expect(database.calls[1]).toMatchObject({
      sql: expect.stringContaining("ON CONFLICT (key) DO UPDATE"),
      values: ["state:key", '{"ready":false}', timestamp],
    });
    expect(database.calls.every(({ sql }) => !sql.includes("?"))).toBe(true);
    expect(database.released).toBe(2);
  });

  it("returns null for missing state and releases the client when a read fails", async () => {
    const database = scriptedPool(() => []);
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });
    const failure = new Error("synthetic database failure");

    await expect(service.getState("missing")).resolves.toBeNull();
    database.respond = () => { throw failure; };
    await expect(service.getState("error")).rejects.toBe(failure);
    expect(database.released).toBe(2);
  });

  it("preserves channel and login status response contracts", async () => {
    const database = scriptedPool((sql) => {
      if (sql.includes("FROM inbox_server.worker_state")) {
        return [{ value: '{"destinations":[],"sources":{"zhihu":{"enabled":true}}}' }];
      }
      return [];
    });
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });

    await expect(service.getChannels()).resolves.toEqual({
      destinations: {},
      sources: { zhihu: { enabled: true } },
      status: "ok",
    });
    await expect(service.getLoginStatus("zhihu")).resolves.toEqual({
      note: "尚未建立登录会话（需先同步触发 worker 登录）",
      platform: "zhihu",
      session_status: "none",
      status: "ok",
    });
    database.respond = (sql) => sql.includes("FROM inbox_server.login_sessions")
      ? [{ status: "expired", expires_at: timestamp, last_used_at: null, last_error: "expired" }]
      : [];
    await expect(service.getLoginStatus("bilibili")).resolves.toEqual({
      expires_at: timestamp,
      last_error: "expired",
      last_used_at: null,
      platform: "bilibili",
      session_status: "expired",
      status: "ok",
    });
    expect(database.released).toBe(3);
  });

  it("decrypts existing bytea credentials and stores compatible encrypted sessions", async () => {
    const credential = await encryptJson({ token: "synthetic" }, encryptionKey);
    const database = scriptedPool((sql) =>
      sql.includes("FROM inbox_server.credentials")
        ? [{ payload_encrypted: credential }]
        : [],
    );
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      now: () => new Date(timestamp),
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });

    await expect(service.getCredential("zhihu_creds")).resolves.toEqual({ token: "synthetic" });
    await service.putLoginSession("youtube", {
      expiresAt: "2030-02-01T00:00:00.000Z",
      lastError: null,
      state: { cookies: [{ name: "session", value: "synthetic" }] },
      status: "active",
    });
    const write = database.calls[1];
    expect(write?.sql).toContain("inbox_server.login_sessions");
    expect(write?.sql).toContain("ON CONFLICT (platform) DO UPDATE");
    expect(write?.values?.[1]).toBeInstanceOf(Uint8Array);
    await expect(decryptJson(write?.values?.[1] as Uint8Array, encryptionKey)).resolves.toEqual({
      cookies: [{ name: "session", value: "synthetic" }],
    });
    expect(write?.values).toEqual([
      "youtube",
      write?.values?.[1],
      "active",
      "2030-02-01T00:00:00.000Z",
      timestamp,
      null,
      timestamp,
      timestamp,
    ]);
    expect(database.released).toBe(2);
  });

  it("groups dead letters and summarizes supported item kinds", async () => {
    const database = scriptedPool((sql) => {
      if (sql.includes("FROM inbox_server.worker_dead_letters ORDER BY")) {
        return [
          { job_id: "link-1", item_kind: "link", attempts: 2 },
          { job_id: "article-1", item_kind: "article", attempts: 3 },
          { job_id: "ignored", item_kind: "unknown", attempts: 1 },
        ];
      }
      if (sql.includes("GROUP BY item_kind, status")) {
        return [
          { item_kind: "link", status: "done", count: "2" },
          { item_kind: "link", status: "processing", count: "3" },
          { item_kind: "article", status: "failed", count: "4" },
          { item_kind: "unknown", status: "done", count: "9" },
        ];
      }
      return [
        { item_kind: "link", count: "1" },
        { item_kind: "article", count: "1" },
        { item_kind: "unknown", count: "7" },
      ];
    });
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });

    await expect(service.getQueueDlq()).resolves.toEqual({
      counts: { link: 1, text: 0, file: 0, article: 1 },
      dlq: {
        link: [{ job_id: "link-1", item_kind: "link", attempts: 2 }],
        text: [],
        file: [],
        article: [{ job_id: "article-1", item_kind: "article", attempts: 3 }],
      },
      status: "ok",
    });
    await expect(service.getQueueSummary()).resolves.toEqual({
      queues: {
        link: { done: 2, pending: 3, dlq: 1 },
        text: { done: 0, pending: 0, dlq: 0 },
        file: { done: 0, pending: 0, dlq: 0 },
        article: { done: 0, pending: 4, dlq: 1 },
      },
      status: "ok",
    });
    expect(database.calls.map(({ sql }) => sql)).toEqual([
      expect.stringContaining("inbox_server.worker_dead_letters"),
      expect.stringContaining("inbox_server.worker_jobs"),
      expect.stringContaining("inbox_server.worker_dead_letters"),
    ]);
    expect(database.released).toBe(2);
  });

  it("records article events, heartbeats, and bounded invalid-job dead letters", async () => {
    const database = scriptedPool((sql) => sql.includes("ORDER BY last_seen_at::timestamptz DESC")
      ? [{ details: '{"state":"ready"}', last_seen_at: timestamp, worker_id: "worker-1" }]
      : []);
    const heartbeatCache = {
      get: vi.fn(async () => null),
      setIfNewer: vi.fn(async () => undefined),
    };
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      heartbeatCache,
      now: () => new Date(timestamp),
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });

    await service.recordArticleEvent({
      filename: "archive.md",
      reason: null,
      sourceUrl: "https://example.invalid/source",
      status: "saved",
      title: "synthetic",
      urlFingerprint: "fingerprint",
    });
    await service.recordHeartbeat("worker-1", { state: "ready" });
    await service.rejectInvalidJob({
      attempts: 2,
      messageId: "message-1",
      payloadDigest: "digest",
      reason: "x".repeat(600),
    });

    expect(database.calls[0]).toMatchObject({
      sql: expect.stringContaining("INSERT INTO inbox_server.article_archive_events"),
      values: [
        "https://example.invalid/source",
        "fingerprint",
        "synthetic",
        "saved",
        null,
        "archive.md",
        timestamp,
      ],
    });
    expect(database.calls[1]).toMatchObject({
      sql: expect.stringContaining("INSERT INTO inbox_server.worker_heartbeats"),
      values: ["worker-1", timestamp, '{"state":"ready"}'],
    });
    expect(database.calls[1]).toMatchObject({
      sql: expect.stringContaining("ON CONFLICT (worker_id) DO UPDATE"),
      values: ["worker-1", timestamp, '{"state":"ready"}'],
    });
    expect(database.calls[1]?.sql).toContain("WHERE hb.last_seen_at::timestamptz <= EXCLUDED.last_seen_at::timestamptz");
    expect(database.calls[2]).toMatchObject({
      sql: expect.stringContaining("ORDER BY last_seen_at::timestamptz DESC, worker_id DESC"),
    });
    expect(heartbeatCache.setIfNewer).toHaveBeenCalledWith({
      details: '{"state":"ready"}',
      last_seen_at: timestamp,
      worker_id: "worker-1",
    });
    expect(database.calls[3]).toMatchObject({
      sql: expect.stringContaining("INSERT INTO inbox_server.worker_dead_letters"),
      values: ["message-1", "invalid:message-1", 2, "x".repeat(500), "digest", timestamp],
    });
    expect(database.calls.filter((_, index) => index !== 2).every(({ sql }) => sql.includes("$"))).toBe(true);
    expect(database.released).toBe(3);
  });

  it("keeps the Neon heartbeat write successful when the cache is unavailable", async () => {
    const database = scriptedPool((sql) => sql.includes("ORDER BY last_seen_at::timestamptz DESC")
      ? [{ details: '{"state":"ready"}', last_seen_at: timestamp, worker_id: "worker-1" }]
      : []);
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      heartbeatCache: {
        get: async () => null,
        setIfNewer: async () => { throw new Error("synthetic cache outage"); },
      },
      now: () => new Date(timestamp),
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });

    await expect(service.recordHeartbeat("worker-1", { state: "ready" })).resolves.toBeUndefined();
    expect(database.calls[0]?.sql).toContain("INSERT INTO inbox_server.worker_heartbeats");
    expect(database.released).toBe(1);
  });

  it("writes only supported encrypted cookies and keeps the D1 response", async () => {
    const database = scriptedPool(() => []);
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      now: () => new Date(timestamp),
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });

    await expect(service.writeCookie("unsupported", {})).rejects.toBeInstanceOf(
      UnsupportedCookiePlatformError,
    );
    await expect(service.writeCookie("zhihu", {})).rejects.toBeInstanceOf(
      MissingCookieFieldError,
    );
    await expect(service.writeCookie("zhihu", { z_c0: "synthetic-cookie" })).resolves.toEqual({
      note: "凭据已存，登录态将在下次同步时由 worker 建立",
      platform: "zhihu",
      status: "ok",
      vault_id: "zhihu_creds",
    });
    const write = database.calls[0];
    expect(write?.sql).toContain("INSERT INTO inbox_server.credentials");
    expect(write?.sql).toContain("ON CONFLICT (name) DO UPDATE");
    expect(write?.values?.slice(0, 2)).toEqual(["zhihu_creds", "zhihu"]);
    await expect(decryptJson(write?.values?.[2] as Uint8Array, encryptionKey)).resolves.toEqual({
      z_c0: "synthetic-cookie",
    });
    expect(database.released).toBe(1);
  });

  it("atomically upserts an encrypted Inoreader session credential and reads it back", async () => {
    let encryptedState: Uint8Array | undefined;
    const database = scriptedPool((sql) =>
      sql.includes("FROM inbox_server.credentials") && encryptedState
        ? [{ payload_encrypted: encryptedState }]
        : [],
    );
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      now: () => new Date(timestamp),
      pool: database.pool,
      producer: { sendBatch: vi.fn() },
    });
    const state = {
      cookies: [
        {
          domain: ".inoreader.com",
          name: "synthetic-session",
          path: "/",
          value: "synthetic-value",
        },
      ],
      origins: [],
    };

    await (service as unknown as {
      saveInoreaderSessionCredential(value: unknown): Promise<void>;
    }).saveInoreaderSessionCredential(state);

    const write = database.calls[0];
    expect(write?.sql).toContain("INSERT INTO inbox_server.credentials");
    expect(write?.sql).toContain("VALUES ($1, $2, 'session', $3, $4, $5)");
    expect(write?.sql).toContain("ON CONFLICT (name) DO UPDATE");
    expect(write?.values?.slice(0, 2)).toEqual(["inoreader_creds", "inoreader"]);
    expect(write?.values?.[2]).toBeInstanceOf(Uint8Array);
    encryptedState = write?.values?.[2] as Uint8Array;
    await expect(
      decryptJson(encryptedState, encryptionKey),
    ).resolves.toEqual(state);
    await expect(service.getCredential("inoreader_creds")).resolves.toEqual(state);
    expect(database.calls).toHaveLength(2);
    expect(database.released).toBe(2);
  });

  it("validates a complete job batch before publishing and returns its count", async () => {
    const sendBatch = vi.fn(async () => undefined);
    const database = scriptedPool(() => []);
    const service = createPostgresControlPlaneDataService({
      encryptionKey,
      pool: database.pool,
      producer: { sendBatch },
    });
    const job: QueueJob = {
      createdAt: timestamp,
      dedupeKey: "dispatch:link:synthetic",
      jobId: "657cb0ad-169b-4cce-92c1-000000000001",
      kind: "dispatch-item",
      payload: { itemKind: "link", url: "https://example.invalid" },
      schemaVersion: 1,
    };

    await expect(service.publishJobs([job])).resolves.toEqual({ queued: 1 });
    expect(sendBatch).toHaveBeenCalledWith([job]);
    await expect(service.publishJobs([{ ...job, jobId: "invalid" }])).rejects.toThrow();
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });
});

function scriptedPool(initialRespond: (sql: string) => Record<string, unknown>[]) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let respond = initialRespond;
  let released = 0;
  return {
    calls,
    get released() {
      return released;
    },
    set respond(next: typeof respond) {
      respond = next;
    },
    pool: {
      async connect() {
        return {
          async query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
            calls.push(values === undefined ? { sql } : { sql, values });
            return { rows: respond(sql) as Row[] };
          },
          release() {
            released += 1;
          },
        };
      },
    } as PostgresPool,
  };
}
