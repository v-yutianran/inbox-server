import { describe, expect, it, vi } from "vitest";

import type { ApiBindings } from "../src/auth";
import worker, { publishScheduledCollection } from "../src/index";
import type { OperationsService } from "../src/operations";
import type { OperationsReadinessService } from "../src/operations-readiness";

describe("Cron Trigger", () => {
  function createService(): OperationsService {
    const requestScheduledSync = vi.fn().mockResolvedValue({ results: {}, status: "ok" });
    return {
      getOverview: vi.fn(),
      listArticleEvents: vi.fn(),
      listSyncJobs: vi.fn(),
      replaceSnapshot: vi.fn(),
      requestManualSync: vi.fn(),
      requestScheduledSync,
    } satisfies OperationsService;
  }

  function createReadinessService(): OperationsReadinessService {
    return {
      captureMetrics: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperationsReadinessService;
  }

  it("冻结时不采集指标、不发布计划任务、不唤醒 worker，也不登记 Cron 工作", async () => {
    const service = createService();
    const readiness = createReadinessService();
    const workerFetch = vi.fn<typeof fetch>();
    const bindings = {
      MIGRATION_FROZEN: "true",
      SCHEDULE_ENABLED: "true",
      WORKER_WEBHOOK_URL: "https://worker.example/webhooks/worker",
      WORKER_WEBHOOK_TOKEN: "synthetic-token",
    } as unknown as ApiBindings;

    await publishScheduledCollection(
      bindings,
      () => service,
      () => readiness,
      workerFetch,
    );

    expect(readiness.captureMetrics).not.toHaveBeenCalled();
    expect(service.requestScheduledSync).not.toHaveBeenCalled();
    expect(workerFetch).not.toHaveBeenCalled();
  });

  it("冻结时 Cron 入口不登记 waitUntil 工作", () => {
    const waitUntil = vi.fn();

    worker.scheduled(
      {} as ScheduledController,
      { MIGRATION_FROZEN: "true" } as unknown as ApiBindings,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([undefined, "false"])(
    "MIGRATION_FROZEN=%s 时保持既有计划任务行为",
    async (migrationFrozen) => {
      const service = createService();
      const readiness = createReadinessService();

      await publishScheduledCollection(
        {
          ...(migrationFrozen === undefined ? {} : { MIGRATION_FROZEN: migrationFrozen }),
          SCHEDULE_ENABLED: "false",
        } as ApiBindings,
        () => service,
        () => readiness,
      );

      expect(service.requestScheduledSync).not.toHaveBeenCalled();
      expect(readiness.captureMetrics).toHaveBeenCalledOnce();
    },
  );

  it("显式启用后只发布到期收集任务，不在请求内执行浏览器来源", async () => {
    const service = createService();
    const readiness = createReadinessService();

    await publishScheduledCollection(
      { SCHEDULE_ENABLED: "true" } as ApiBindings,
      () => service,
      () => readiness,
    );

    expect(service.requestScheduledSync).toHaveBeenCalledOnce();
    expect(readiness.captureMetrics).toHaveBeenCalledOnce();
  });

  it("运维样本采集失败时留下稳定事件但不阻断主收集计划", async () => {
    const service = createService();
    const readiness = createReadinessService();
    vi.mocked(readiness.captureMetrics).mockRejectedValue(new Error("synthetic failure"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await publishScheduledCollection(
      { SCHEDULE_ENABLED: "true" } as ApiBindings,
      () => service,
      () => readiness,
    );

    expect(service.requestScheduledSync).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      event: "operations.metrics.capture_failed",
      service: "api",
    });
    error.mockRestore();
  });

  it("周期唤醒失败写固定事件且不阻断原定时发布", async () => {
    const service = createService();
    const readiness = createReadinessService();
    const url = "https://worker.example/webhooks/worker";
    const token = "synthetic-token";
    const responseSecret = "synthetic-response-secret";
    const workerFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(`${url} ${token} ${responseSecret}`, { status: 500 }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await publishScheduledCollection(
      {
        SCHEDULE_ENABLED: "true",
        WORKER_WEBHOOK_URL: url,
        WORKER_WEBHOOK_TOKEN: token,
      } as ApiBindings,
      () => service,
      () => readiness,
      workerFetch,
    );

    expect(service.requestScheduledSync).toHaveBeenCalledOnce();
    expect(workerFetch).toHaveBeenCalledOnce();
    expect(workerFetch).toHaveBeenCalledWith(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(error).toHaveBeenCalledOnce();
    const log = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(log)).toEqual({
      event: "worker.webhook.wake_failed",
      service: "api",
      trigger: "cron",
    });
    expect(log).not.toContain(url);
    expect(log).not.toContain(token);
    expect(log).not.toContain(responseSecret);
    error.mockRestore();
  });

  it("Cron 在计划发布关闭时仍周期唤醒积压 worker", async () => {
    const service = createService();
    const readiness = createReadinessService();
    const workerFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await publishScheduledCollection(
      {
        SCHEDULE_ENABLED: "false",
        WORKER_WEBHOOK_URL: "https://worker.example/webhooks/worker",
        WORKER_WEBHOOK_TOKEN: "synthetic-token",
      } as ApiBindings,
      () => service,
      () => readiness,
      workerFetch,
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(service.requestScheduledSync).not.toHaveBeenCalled();
  });
});
