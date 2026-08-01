import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  requireApiKey,
  requireWorkerToken,
  type ApiBindings,
} from "../src/auth";
import type {
  OperationsOverview,
  OperationsService,
} from "../src/operations";

const overview: OperationsOverview = {
  article_events: [],
  channels: {
    destinations: {},
    sources: { telegram: { enabled: true, item_kind: "text", kind: "api" } },
  },
  generated_at: "2026-08-01T02:50:00.000Z",
  queues: {
    article: { dlq: 0, done: 1, pending: 0 },
    file: { dlq: 0, done: 2, pending: 0 },
    link: { dlq: 0, done: 3, pending: 1 },
    text: { dlq: 0, done: 4, pending: 0 },
  },
  scheduler: { enabled: true, interval_seconds: 600, next_run_at: null },
  server: { online: true },
  status: "ok",
  sync_jobs: [],
  worker: { last_heartbeat_at: "2026-08-01T02:49:50.000Z", online: true },
};

function createOperationsService(): OperationsService {
  return {
    getOverview: vi.fn().mockResolvedValue(overview),
    listArticleEvents: vi.fn().mockResolvedValue([]),
    listSyncJobs: vi.fn().mockResolvedValue([]),
    replaceSnapshot: vi.fn().mockResolvedValue(undefined),
    requestManualSync: vi.fn().mockResolvedValue({
      results: { queued: { telegram: 1 } },
      status: "ok",
    }),
    requestScheduledSync: vi.fn().mockResolvedValue({ results: {}, status: "ok" }),
  };
}

describe("health routes", () => {
  it("保持现有 liveness 与 readiness 响应", async () => {
    const app = createApp();

    const health = await app.request("/healthz");
    const ready = await app.request("/readyz");

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
  });

  it("只允许 inbox-server Console 的 Pages 域名跨域访问", async () => {
    const app = createApp();
    const bindings = {
      ADMIN_API_KEY: "admin-secret",
      WORKER_SERVICE_TOKEN: "worker-secret",
      CONSOLE_ORIGINS: "https://console.example.com",
    };

    const pagesPreview = await app.request(
      "/healthz",
      { headers: { Origin: "https://abc123.inbox-server-console.pages.dev" } },
      bindings,
    );
    const configured = await app.request(
      "/healthz",
      { headers: { Origin: "https://console.example.com" } },
      bindings,
    );
    const denied = await app.request(
      "/healthz",
      { headers: { Origin: "https://malicious.example" } },
      bindings,
    );

    expect(pagesPreview.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://abc123.inbox-server-console.pages.dev",
    );
    expect(configured.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://console.example.com",
    );
    expect(denied.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("允许 Console 使用 API key 发起跨域预检请求", async () => {
    const app = createApp();
    const origin = "https://abc123.inbox-server-console.pages.dev";

    const response = await app.request("/healthz", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Headers": "X-API-Key",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-API-Key");
  });
});

describe("authentication middleware", () => {
  it("未配置外部 key 时保持开发模式开放", async () => {
    const app = new Hono<{ Bindings: ApiBindings }>();
    app.get("/protected", requireApiKey, (context) => context.json({ ok: true }));

    const response = await app.request("/protected", undefined, {
      ADMIN_API_KEY: "",
      WORKER_SERVICE_TOKEN: "worker-secret",
    });

    expect(response.status).toBe(200);
  });

  it("配置外部 key 后拒绝错误值并接受正确值", async () => {
    const app = new Hono<{ Bindings: ApiBindings }>();
    app.get("/protected", requireApiKey, (context) => context.json({ ok: true }));
    const bindings = {
      ADMIN_API_KEY: "admin-secret",
      WORKER_SERVICE_TOKEN: "worker-secret",
    };

    const denied = await app.request(
      "/protected",
      { headers: { "X-API-Key": "wrong" } },
      bindings,
    );
    const allowed = await app.request(
      "/protected",
      { headers: { "X-API-Key": "admin-secret" } },
      bindings,
    );

    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ detail: "invalid api key" });
    expect(allowed.status).toBe(200);
  });

  it("worker token 与外部 API key 使用独立认证边界", async () => {
    const app = new Hono<{ Bindings: ApiBindings }>();
    app.get("/internal", requireWorkerToken, (context) => context.json({ ok: true }));
    const bindings = {
      ADMIN_API_KEY: "admin-secret",
      WORKER_SERVICE_TOKEN: "worker-secret",
    };

    const denied = await app.request(
      "/internal",
      { headers: { Authorization: "Bearer admin-secret" } },
      bindings,
    );
    const allowed = await app.request(
      "/internal",
      { headers: { Authorization: "Bearer worker-secret" } },
      bindings,
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });
});

describe("operations routes", () => {
  it("使用有效 API key 返回 Console 所需的完整 overview 契约", async () => {
    const service = createOperationsService();
    const app = createApp({ createOperationsService: () => service });

    const denied = await app.request(
      "/api/operations/overview",
      { headers: { "X-API-Key": "wrong" } },
      { ADMIN_API_KEY: "admin-secret" },
    );
    const allowed = await app.request(
      "/api/operations/overview",
      { headers: { "X-API-Key": "admin-secret" } },
      { ADMIN_API_KEY: "admin-secret" },
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual(overview);
    expect(service.getOverview).toHaveBeenCalledOnce();
  });

  it("Queue 消费者未启用时拒绝手动同步，避免制造假成功", async () => {
    const service = createOperationsService();
    const app = createApp({ createOperationsService: () => service });

    const response = await app.request(
      "/sync",
      { method: "POST", headers: { "X-API-Key": "admin-secret" } },
      { ADMIN_API_KEY: "admin-secret", SYNC_PUBLISH_ENABLED: "false" },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: "sync queue consumer unavailable" });
    expect(service.requestManualSync).not.toHaveBeenCalled();
  });

  it("显式启用 Queue 消费者后，手动同步保持现有响应 shape", async () => {
    const service = createOperationsService();
    const app = createApp({ createOperationsService: () => service });

    const response = await app.request(
      "/sync",
      { method: "POST", headers: { "X-API-Key": "admin-secret" } },
      { ADMIN_API_KEY: "admin-secret", SYNC_PUBLISH_ENABLED: "true" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: { queued: { telegram: 1 } },
      status: "ok",
    });
    expect(service.requestManualSync).toHaveBeenCalledOnce();
  });

  it("只允许 worker service token 更新 D1 运行快照", async () => {
    const service = createOperationsService();
    const app = createApp({ createOperationsService: () => service });

    const denied = await app.request(
      "/internal/operations/snapshot",
      { method: "PUT", body: JSON.stringify(overview) },
      { WORKER_SERVICE_TOKEN: "worker-secret" },
    );
    const allowed = await app.request(
      "/internal/operations/snapshot",
      {
        method: "PUT",
        body: JSON.stringify(overview),
        headers: {
          Authorization: "Bearer worker-secret",
          "Content-Type": "application/json",
        },
      },
      { WORKER_SERVICE_TOKEN: "worker-secret" },
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(204);
    expect(service.replaceSnapshot).toHaveBeenCalledWith(overview);
  });
});
