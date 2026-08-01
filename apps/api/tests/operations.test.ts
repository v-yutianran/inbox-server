import { describe, expect, it } from "vitest";

import { normalizeOverviewStatus, type OperationsOverview } from "../src/operations";

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
});
