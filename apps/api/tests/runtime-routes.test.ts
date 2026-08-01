import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { ControlPlaneService } from "../src/control-plane";
import type { QueueInboxService } from "../src/queue-inbox";

function createService(): ControlPlaneService {
  return {
    claimEffect: vi.fn().mockResolvedValue({ state: "claimed" }),
    claimJob: vi.fn().mockResolvedValue({ attempts: 1, state: "claimed" }),
    consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }),
    finishEffect: vi.fn().mockResolvedValue(undefined),
    finishJob: vi.fn().mockResolvedValue({ settlement: "ack" }),
    getChannels: vi.fn().mockResolvedValue({
      destinations: { cubox: { enabled: true, item_kind: "link" } },
      sources: { telegram: { credential_name: null, enabled: true, kind: "api" } },
      status: "ok",
    }),
    getCredential: vi.fn().mockResolvedValue({ bot_token: "worker-only" }),
    getLoginStatus: vi.fn().mockResolvedValue({
      note: "尚未建立登录会话（需先同步触发 worker 登录）",
      platform: "zhihu",
      session_status: "none",
      status: "ok",
    }),
    getQueueDlq: vi.fn().mockResolvedValue({
      counts: { article: 0, file: 0, link: 1, text: 0 },
      dlq: { article: [], file: [], link: [{ attempts: 3 }], text: [] },
      status: "ok",
    }),
    getQueueSummary: vi.fn().mockResolvedValue({
      queues: {
        article: { dlq: 0, done: 0, pending: 0 },
        file: { dlq: 0, done: 0, pending: 0 },
        link: { dlq: 1, done: 8, pending: 2 },
        text: { dlq: 0, done: 3, pending: 0 },
      },
      status: "ok",
    }),
    getState: vi.fn().mockResolvedValue({ knownKeys: ["a"] }),
    publishJobs: vi.fn().mockResolvedValue({ queued: 1 }),
    putLoginSession: vi.fn().mockResolvedValue(undefined),
    putState: vi.fn().mockResolvedValue(undefined),
    recordArticleEvent: vi.fn().mockResolvedValue(undefined),
    recordHeartbeat: vi.fn().mockResolvedValue(undefined),
    rejectInvalidJob: vi.fn().mockResolvedValue(undefined),
    writeCookie: vi.fn().mockResolvedValue({
      note: "凭据已存，登录态将在下次同步时由 worker 建立",
      platform: "zhihu",
      status: "ok",
      vault_id: "zhihu_creds",
    }),
  };
}

function queueInbox(): QueueInboxService {
  return {
    pull: vi.fn().mockResolvedValue({ backlogCount: 1, messages: [] }),
    settle: vi.fn().mockResolvedValue(undefined),
    stage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("management compatibility routes", () => {
  it("保持 queue、dlq、channels 与 login 的响应 shape 和鉴权", async () => {
    const service = createService();
    const app = createApp({ createControlPlaneService: () => service });
    const bindings = { ADMIN_API_KEY: "admin", WORKER_SERVICE_TOKEN: "worker" };

    expect((await app.request("/queue", undefined, bindings)).status).toBe(401);
    const queue = await app.request(
      "/queue",
      { headers: { "X-API-Key": "admin" } },
      bindings,
    );
    const dlq = await app.request(
      "/queue/dlq",
      { headers: { "X-API-Key": "admin" } },
      bindings,
    );
    const channels = await app.request(
      "/channels",
      { headers: { "X-API-Key": "admin" } },
      bindings,
    );
    const login = await app.request(
      "/login/zhihu/cookie",
      {
        body: JSON.stringify({ z_c0: "cookie" }),
        headers: { "Content-Type": "application/json", "X-API-Key": "admin" },
        method: "POST",
      },
      bindings,
    );

    expect(queue.status).toBe(200);
    const queueBody = (await queue.json()) as { queues: { link: unknown } };
    const dlqBody = (await dlq.json()) as { counts: { link: number } };
    const channelsBody = (await channels.json()) as {
      sources: { telegram: { enabled: boolean } };
    };
    const loginBody = (await login.json()) as { vault_id: string };
    expect(queueBody.queues.link).toEqual({ dlq: 1, done: 8, pending: 2 });
    expect(dlqBody.counts.link).toBe(1);
    expect(channelsBody.sources.telegram.enabled).toBe(true);
    expect(login.status).toBe(200);
    expect(loginBody.vault_id).toBe("zhihu_creds");
    expect(service.writeCookie).toHaveBeenCalledWith("zhihu", { z_c0: "cookie" });
  });

  it("保持 login 校验错误状态码", async () => {
    const app = createApp({ createControlPlaneService: () => createService() });
    const bindings = { ADMIN_API_KEY: "admin", WORKER_SERVICE_TOKEN: "worker" };
    const request = (platform: string, body: unknown) =>
      app.request(
        `/login/${platform}/cookie`,
        {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json", "X-API-Key": "admin" },
          method: "POST",
        },
        bindings,
      );

    expect((await request("unknown", { x: "y" })).status).toBe(400);
    expect((await request("zhihu", {})).status).toBe(400);
  });
});

describe("worker control-plane routes", () => {
  it("worker 通过服务令牌领取并结算 D1 lease", async () => {
    const inbox = queueInbox();
    const app = createApp({ createQueueInboxService: () => inbox });
    const bindings = { WORKER_SERVICE_TOKEN: "worker" };
    const headers = {
      Authorization: "Bearer worker",
      "Content-Type": "application/json",
    };

    expect(
      (await app.request("/internal/queue/pull", { method: "POST" }, bindings)).status,
    ).toBe(401);
    const pull = await app.request(
      "/internal/queue/pull",
      {
        body: JSON.stringify({ batchSize: 10, visibilityTimeoutMs: 60_000 }),
        headers,
        method: "POST",
      },
      bindings,
    );
    const settle = await app.request(
      "/internal/queue/settle",
      {
        body: JSON.stringify({ acks: ["lease-1"], retries: [] }),
        headers,
        method: "POST",
      },
      bindings,
    );

    expect(pull.status).toBe(200);
    expect(await pull.json()).toEqual({ backlogCount: 1, messages: [] });
    expect(settle.status).toBe(204);
    expect(inbox.settle).toHaveBeenCalledWith({ acks: ["lease-1"], retries: [] });
  });

  it("worker token 可 claim、持久化完成后再取得 ack 决策", async () => {
    const service = createService();
    const app = createApp({ createControlPlaneService: () => service });
    const bindings = { ADMIN_API_KEY: "admin", WORKER_SERVICE_TOKEN: "worker" };
    const headers = {
      Authorization: "Bearer worker",
      "Content-Type": "application/json",
    };
    const job = {
      createdAt: "2026-08-01T03:00:00.000Z",
      dedupeKey: "collect:telegram:test",
      jobId: "0f868f15-3b77-4ac8-90d9-f7b59c9721ee",
      kind: "collect-source",
      payload: { shadow: true, source: "telegram", triggeredBy: "shadow" },
      schemaVersion: 1,
    };

    const claim = await app.request(
      "/internal/jobs/claim",
      { body: JSON.stringify({ job }), headers, method: "POST" },
      bindings,
    );
    const finish = await app.request(
      `/internal/jobs/${job.jobId}/result`,
      {
        body: JSON.stringify({ status: "done", summary: { collected: 0 } }),
        headers,
        method: "PUT",
      },
      bindings,
    );

    expect(claim.status).toBe(200);
    expect(await claim.json()).toEqual({ attempts: 1, state: "claimed" });
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ settlement: "ack" });
    expect(service.finishJob).toHaveBeenCalledWith(job.jobId, {
      status: "done",
      summary: { collected: 0 },
    });
  });

  it("外部 API key 不能读取 worker 专用凭据", async () => {
    const app = createApp({ createControlPlaneService: () => createService() });
    const response = await app.request(
      "/internal/credentials/telegram_creds",
      { headers: { Authorization: "Bearer admin" } },
      { ADMIN_API_KEY: "admin", WORKER_SERVICE_TOKEN: "worker" },
    );

    expect(response.status).toBe(401);
  });

  it("无效队列载荷先进入 D1 死信再返回 204", async () => {
    const service = createService();
    const app = createApp({ createControlPlaneService: () => service });
    const body = {
      attempts: 3,
      messageId: "bad-message",
      payloadDigest: "a".repeat(64),
      reason: "invalid queue job",
    };

    const response = await app.request(
      "/internal/jobs/reject",
      {
        body: JSON.stringify(body),
        headers: {
          Authorization: "Bearer worker",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      { WORKER_SERVICE_TOKEN: "worker" },
    );

    expect(response.status).toBe(204);
    expect(service.rejectInvalidJob).toHaveBeenCalledWith(body);
  });
});
