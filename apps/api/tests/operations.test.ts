import { describe, expect, it } from "vitest";

import {
  advanceSyncJob,
  resolveWorkerHeartbeat,
  normalizeOverviewStatus,
  resolveCollectionShadowMode,
  type OperationsOverview,
} from "../src/operations";

const overview: OperationsOverview = {
  article_events: [],
  channels: { destinations: {}, sources: {} },
  generated_at: "2026-08-01T02:49:50.000Z",
  queues: {
    article: { dlq: 0, done: 0, pending: 0 },
    file: { dlq: 0, done: 0, pending: 0 },
    link: { dlq: 0, done: 0, pending: 0 },
    text: { dlq: 0, done: 0, pending: 0 },
  },
  scheduler: { enabled: true, interval_seconds: 600, next_run_at: null },
  server: { online: true },
  status: "ok",
  sync_jobs: [],
  worker: { last_heartbeat_at: "2026-08-01T02:49:50.000Z", online: true },
};

describe("normalizeOverviewStatus", () => {
  it("使用 D1 最新 heartbeat 覆盖迁移快照中的旧状态", () => {
    const resolved = resolveWorkerHeartbeat(
      overview.worker,
      "2026-08-01T18:29:20.000Z",
    );

    expect(resolved).toEqual({
      last_heartbeat_at: "2026-08-01T18:29:20.000Z",
      online: true,
    });
  });

  it("旧服务快照的 heartbeat 超时后不继续显示在线", () => {
    const normalized = normalizeOverviewStatus(
      overview,
      new Date("2026-08-01T02:52:00.000Z"),
      false,
    );

    expect(normalized.worker.online).toBe(false);
    expect(normalized.scheduler.enabled).toBe(false);
    expect(normalized.generated_at).toBe("2026-08-01T02:52:00.000Z");
  });

  it("90 秒内的 heartbeat 仍视为在线", () => {
    const normalized = normalizeOverviewStatus(
      overview,
      new Date("2026-08-01T02:51:20.000Z"),
      true,
    );

    expect(normalized.worker.online).toBe(true);
    expect(normalized.scheduler.enabled).toBe(true);
  });

  it("按调度间隔生成未来的下一次执行时间", () => {
    const normalized = normalizeOverviewStatus(
      overview,
      new Date("2026-08-01T18:29:29.386Z"),
      true,
    );

    expect(normalized.scheduler.next_run_at).toBe("2026-08-01T18:30:00.000Z");
  });
});

describe("resolveCollectionShadowMode", () => {
  it("只有真实 Queue 消费者显式启用后才关闭 shadow", () => {
    expect(resolveCollectionShadowMode("false")).toBe(true);
    expect(resolveCollectionShadowMode(undefined)).toBe(true);
    expect(resolveCollectionShadowMode("true")).toBe(false);
  });
});

describe("advanceSyncJob", () => {
  it("等待全部来源结束后收敛为完成", () => {
    const first = advanceSyncJob(
      { queued: { dida: 1, telegram: 1 } },
      {
        finishedAt: "2026-08-01T11:10:00.000Z",
        source: "telegram",
        status: "done",
        summary: { collected: 2, published: 2 },
      },
    );

    expect(first).toEqual({
      error: null,
      finishedAt: null,
      stats: {
        queued: { dida: 1, telegram: 1 },
        telegram: {
          collected: 2,
          enqueued: { total: 2 },
          published: 2,
          status: "done",
        },
      },
      status: "running",
    });

    expect(
      advanceSyncJob(first.stats, {
        finishedAt: "2026-08-01T11:10:01.000Z",
        source: "dida",
        status: "done",
        summary: { collected: 1, published: 1 },
      }),
    ).toMatchObject({ error: null, finishedAt: "2026-08-01T11:10:01.000Z", status: "done" });
  });

  it("全部来源结束且存在失败时收敛为失败", () => {
    const result = advanceSyncJob(
      {
        queued: { inoreader: 1 },
      },
      {
        errorMessage: "inoreader login expired",
        finishedAt: "2026-08-01T11:10:00.000Z",
        source: "inoreader",
        status: "failed",
      },
    );

    expect(result).toEqual({
      error: "inoreader login expired",
      finishedAt: "2026-08-01T11:10:00.000Z",
      stats: {
        inoreader: {
          enqueued: {},
          error: "inoreader login expired",
          status: "failed",
        },
        queued: { inoreader: 1 },
      },
      status: "failed",
    });
  });
});
