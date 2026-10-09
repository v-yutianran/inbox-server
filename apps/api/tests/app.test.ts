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

describe("migration freeze", () => {
  it("只允许通过 worker token 导入 Inoreader StorageState，即使迁移冻结", async () => {
    const storageState = {
      cookies: [
        {
          domain: ".inoreader.com",
          name: "synthetic-session",
          path: "/",
          value: "synthetic-value",
        },
      ],
      origins: [
        {
          localStorage: [{ name: "synthetic-key", value: "synthetic-value" }],
          origin: "https://www.inoreader.com",
        },
      ],
    };
    const saveInoreaderSessionCredential = vi.fn().mockResolvedValue(undefined);
    const createControlPlaneService = vi.fn(
      () => ({ saveInoreaderSessionCredential }) as never,
    );
    const app = createApp({ createControlPlaneService });
    const bindings = {
      DATA_BACKEND: "postgres",
      MIGRATION_FROZEN: "true",
      WORKER_SERVICE_TOKEN: "worker-secret",
    } as never;

    const wrongMethod = await app.request(
      "/internal/credentials/inoreader_creds",
      { method: "POST", body: JSON.stringify(storageState) },
      bindings,
    );
    const wrongPath = await app.request(
      "/internal/credentials/inoreader_creds/other",
      {
        method: "PUT",
        body: JSON.stringify(storageState),
        headers: { Authorization: "Bearer worker-secret" },
      },
      bindings,
    );
    const denied = await app.request(
      "/internal/credentials/inoreader_creds",
      {
        method: "PUT",
        body: JSON.stringify(storageState),
        headers: { "Content-Type": "application/json" },
      },
      bindings,
    );
    const allowed = await app.request(
      "/internal/credentials/inoreader_creds",
      {
        method: "PUT",
        body: JSON.stringify(storageState),
        headers: {
          Authorization: "Bearer worker-secret",
          "Content-Type": "application/json",
        },
      },
      bindings,
    );

    expect(wrongMethod.status).toBe(503);
    expect(wrongPath.status).toBe(503);
    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(204);
    expect(saveInoreaderSessionCredential).toHaveBeenCalledOnce();
    expect(saveInoreaderSessionCredential).toHaveBeenCalledWith(storageState);
  });

  it.each([
    ["non-object", []],
    ["missing arrays", { cookies: [], origins: "invalid" }],
    ["top-level extra key", { cookies: [], origins: [], unexpected: "synthetic" }],
    ["foreign cookie", {
      cookies: [{ domain: "example.com", name: "sid", path: "/", value: "synthetic" }],
      origins: [],
    }],
    ["malformed cookie", {
      cookies: [{ domain: "inoreader.com", name: "sid", path: "/" }],
      origins: [],
    }],
    ["foreign origin", {
      cookies: [],
      origins: [{ localStorage: [], origin: "https://example.com" }],
    }],
    ["insecure origin", {
      cookies: [],
      origins: [{ localStorage: [], origin: "http://www.inoreader.com" }],
    }],
    ["invalid local storage", {
      cookies: [],
      origins: [{ localStorage: [{ name: "sid", value: 1 }], origin: "https://www.inoreader.com" }],
    }],
  ])("迁移冻结时拒绝 %s 的 Inoreader StorageState", async (_name, storageState) => {
    const saveInoreaderSessionCredential = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      createControlPlaneService: () => ({ saveInoreaderSessionCredential }) as never,
    });

    const response = await app.request(
      "/internal/credentials/inoreader_creds",
      {
        method: "PUT",
        body: JSON.stringify(storageState),
        headers: {
          Authorization: "Bearer worker-secret",
          "Content-Type": "application/json",
        },
      },
      {
        DATA_BACKEND: "postgres",
        MIGRATION_FROZEN: "true",
        WORKER_SERVICE_TOKEN: "worker-secret",
      } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "invalid Inoreader storage state" });
    expect(saveInoreaderSessionCredential).not.toHaveBeenCalled();
  });

  it("非 PostgreSQL 后端不接受 Inoreader 凭据导入", async () => {
    const saveInoreaderSessionCredential = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      createControlPlaneService: () => ({ saveInoreaderSessionCredential }) as never,
    });

    const response = await app.request(
      "/internal/credentials/inoreader_creds",
      {
        method: "PUT",
        body: JSON.stringify({ cookies: [], origins: [] }),
        headers: {
          Authorization: "Bearer worker-secret",
          "Content-Type": "application/json",
        },
      },
      { DATA_BACKEND: "d1", WORKER_SERVICE_TOKEN: "worker-secret" } as never,
    );

    expect(response.status).toBe(503);
    expect(saveInoreaderSessionCredential).not.toHaveBeenCalled();
  });

  it("冻结时允许 worker token 读取内部状态，但仍要求 worker 鉴权", async () => {
    const service = { getState: vi.fn().mockResolvedValue({ source: "test" }) };
    const createControlPlaneService = vi.fn(() => service as never);
    const app = createApp({ createControlPlaneService });
    const bindings = {
      MIGRATION_FROZEN: "true",
      WORKER_SERVICE_TOKEN: "worker-secret",
    };
    const body = JSON.stringify({ key: "worker_runtime" });

    const denied = await app.request(
      "/internal/state/read",
      { method: "POST", body, headers: { "Content-Type": "application/json" } },
      bindings as never,
    );
    const allowed = await app.request(
      "/internal/state/read",
      {
        method: "POST",
        body,
        headers: {
          Authorization: "Bearer worker-secret",
          "Content-Type": "application/json",
        },
      },
      bindings as never,
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ value: { source: "test" } });
    expect(createControlPlaneService).toHaveBeenCalledOnce();
    expect(service.getState).toHaveBeenCalledWith("worker_runtime");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "冻结时在路由与鉴权业务逻辑前拒绝 %s",
    async (method) => {
      const createOperationsFactory = vi.fn(() => createOperationsService());
      const app = createApp({ createOperationsService: createOperationsFactory });

      const response = await app.request(
        "/internal/queue/pull",
        { method, body: "not-json" },
        { MIGRATION_FROZEN: "true" } as never,
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: "service writes are frozen for migration",
      });
      expect(createOperationsFactory).not.toHaveBeenCalled();
    },
  );

  it("冻结时仍允许 GET、HEAD 和 OPTIONS", async () => {
    const app = createApp();
    const bindings = { MIGRATION_FROZEN: "true" } as never;

    const get = await app.request("/healthz", undefined, bindings);
    const head = await app.request("/healthz", { method: "HEAD" }, bindings);
    const options = await app.request(
      "/healthz",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://abc123.inbox-server-console.pages.dev",
          "Access-Control-Request-Method": "GET",
        },
      },
      bindings,
    );

    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(options.status).toBe(204);
  });

  it.each([undefined, "false"])(
    "MIGRATION_FROZEN=%s 时保留现有手动同步行为",
    async (migrationFrozen) => {
      const service = createOperationsService();
      const app = createApp({ createOperationsService: () => service });
      const bindings = {
        ADMIN_API_KEY: "admin-secret",
        MIGRATION_FROZEN: migrationFrozen,
        SYNC_PUBLISH_ENABLED: "true",
      };

      const response = await app.request(
        "/sync",
        { method: "POST", headers: { "X-API-Key": "admin-secret" } },
        bindings as never,
      );

      expect(response.status).toBe(200);
      expect(service.requestManualSync).toHaveBeenCalledOnce();
    },
  );
});

describe("authentication middleware", () => {
  it("未配置管理 key 时失败关闭且不回显配置细节", async () => {
    const app = new Hono<{ Bindings: ApiBindings }>();
    app.get("/protected", requireApiKey, (context) => context.json({ ok: true }));

    const response = await app.request("/protected", undefined, {
      ADMIN_API_KEY: "",
      WORKER_SERVICE_TOKEN: "worker-secret",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: "admin authentication unavailable" });
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
