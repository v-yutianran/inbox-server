import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import {
  requireApiKey,
  requireWorkerToken,
  type ApiBindings,
} from "../src/auth";

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
