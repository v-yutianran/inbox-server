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
