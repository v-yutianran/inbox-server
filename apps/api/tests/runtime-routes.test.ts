import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { ControlPlaneService } from "../src/control-plane";
import type { QueueInboxService } from "../src/queue-inbox";
import type { OperationsReadinessService } from "../src/operations-readiness";

function createService(): ControlPlaneService {
  return {
    claimEffect: vi.fn().mockResolvedValue({ state: "claimed" }),
    claimJob: vi.fn().mockResolvedValue({ attempts: 1, state: "claimed" }),
    consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }),
    consumeRateLimits: vi.fn().mockResolvedValue({ allowed: true, counts: {} }),
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
    replayDeadLetter: vi.fn().mockResolvedValue({
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated",
    }),
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

function operationsReadiness(): OperationsReadinessService {
  return {
    captureMetrics: vi.fn().mockResolvedValue(undefined),
    createReplayPlan: vi.fn().mockResolvedValue({
      idempotencyKey: "operation-1",
      jobId: "job-1",
      planHash: "a".repeat(64),
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated",
    }),
    getDlqConsistency: vi.fn().mockResolvedValue({
      counts: { matched: 1 },
      deploymentVersion: "test",
      freezeAt: "2030-01-01T00:00:00.000Z",
      samples: { matched: ["job-1"] },
      totals: { deadJobs: 1, deadLetters: 1 },
      unexplainedCount: 0,
    }),
    getHealthComponents: vi.fn().mockResolvedValue({
      components: [{ component: "api", state: "ready" }],
      generatedAt: "2030-01-01T00:00:00.000Z",
    }),
    getMetrics: vi.fn().mockResolvedValue({
      deploymentVersion: "test",
      generatedAt: "2030-01-01T00:00:00.000Z",
      metrics: [{ current: 1, key: "api.availability", threshold: null, trend: [] }],
      windowHours: 24,
    }),
    getQueueSummary: vi.fn().mockResolvedValue({
      categories: { deferred: 1, executable: 2, nonExecutable: 0, processing: 1 },
      deploymentVersion: "test",
      earliestDeferredAt: "2030-01-01T00:05:00.000Z",
      freezeAt: "2030-01-01T00:00:00.000Z",
      jobStatusCounts: {},
      oldestExecutableAgeSeconds: 60,
    }),
    getRetentionReport: vi.fn().mockResolvedValue({
      cutoffAt: "2029-12-02T00:00:00.000Z",
      dryRun: true,
      generatedAt: "2030-01-01T00:00:00.000Z",
      resources: {},
      retentionDays: 30,
    }),
  };
}

describe("management compatibility routes", () => {
  it("管理重放先生成零写入计划，只执行同参数同哈希且显式确认的请求", async () => {
    const controlPlane = createService();
    const readiness = operationsReadiness();
    const app = createApp({
      createControlPlaneService: () => controlPlane,
      createOperationsReadinessService: () => readiness,
    });
    const bindings = { ADMIN_API_KEY: "admin" };
    const headers = { "Content-Type": "application/json", "X-API-Key": "admin" };
    const payload = { idempotencyKey: "operation-1", jobId: "job-1" };

    const plan = await app.request(
      "/api/operations/replays/plan",
      { body: JSON.stringify(payload), headers, method: "POST" },
      bindings,
    );
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({ planHash: "a".repeat(64), status: "validated" });
    expect(controlPlane.replayDeadLetter).toHaveBeenCalledWith("job-1", {
      dryRun: true,
      idempotencyKey: "operation-1",
    });

    const stale = await app.request(
      "/api/operations/replays/execute",
      {
        body: JSON.stringify({ ...payload, confirm: true, planHash: "b".repeat(64) }),
        headers,
        method: "POST",
      },
      bindings,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ detail: "stale_plan" });

    vi.mocked(controlPlane.replayDeadLetter).mockResolvedValueOnce({
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated",
    }).mockResolvedValueOnce({
      published: true,
      reason: "published",
      replayable: true,
      status: "published",
    });
    const executed = await app.request(
      "/api/operations/replays/execute",
      {
        body: JSON.stringify({ ...payload, confirm: true, planHash: "a".repeat(64) }),
        headers,
        method: "POST",
      },
      bindings,
    );
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({
      operationId: "operation-1",
      planHash: "a".repeat(64),
      published: true,
      status: "published",
    });
    expect(controlPlane.replayDeadLetter).toHaveBeenLastCalledWith("job-1", {
      dryRun: false,
      idempotencyKey: "operation-1",
    });
  });

  it("运维就绪报告受管理 Key 保护且保持只读资源语义", async () => {
    const readiness = operationsReadiness();
    const app = createApp({ createOperationsReadinessService: () => readiness });
    const bindings = { ADMIN_API_KEY: "admin" };

    expect(
      (await app.request("/api/operations/queue/summary", undefined, bindings)).status,
    ).toBe(401);
    const headers = { "X-API-Key": "admin" };
    const [queue, consistency, retention, health, metrics] = await Promise.all([
      app.request("/api/operations/queue/summary", { headers }, bindings),
      app.request("/api/operations/dlq/consistency", { headers }, bindings),
      app.request("/api/operations/retention/report?retentionDays=30", { headers }, bindings),
      app.request("/api/operations/health/components", { headers }, bindings),
      app.request("/api/operations/metrics?windowHours=24", { headers }, bindings),
    ]);

    expect(queue.status).toBe(200);
    expect(consistency.status).toBe(200);
    expect(await consistency.json()).toMatchObject({ unexplainedCount: 0 });
    expect(retention.status).toBe(200);
    expect(health.status).toBe(200);
    expect(metrics.status).toBe(200);
    expect(readiness.getRetentionReport).toHaveBeenCalledWith({ retentionDays: 30 });
  });

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
  it("dead-letter 重放仅允许 worker token 且 dry-run 不回显 payload", async () => {
    const service = createService();
    const app = createApp({ createControlPlaneService: () => service });
    const bindings = { ADMIN_API_KEY: "admin", WORKER_SERVICE_TOKEN: "worker" };
    const body = JSON.stringify({ dryRun: true, idempotencyKey: "operation-1" });

    const denied = await app.request(
      "/internal/dead-letters/job-1/replay",
      { body, headers: { "Content-Type": "application/json" }, method: "POST" },
      bindings,
    );
    const allowed = await app.request(
      "/internal/dead-letters/job-1/replay",
      {
        body,
        headers: {
          Authorization: "Bearer worker",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      bindings,
    );

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      published: false,
      reason: "replayable",
      replayable: true,
      status: "validated",
    });
    expect(service.replayDeadLetter).toHaveBeenCalledWith("job-1", {
      dryRun: true,
      idempotencyKey: "operation-1",
    });
  });

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
