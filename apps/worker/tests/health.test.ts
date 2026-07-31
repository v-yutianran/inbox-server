import { describe, expect, it } from "vitest";

import {
  createWorkerHealthState,
  evaluateLiveness,
  evaluateReadiness,
  reduceWorkerHealthState,
} from "../src/health";

const startedAt = Date.parse("2026-07-31T12:00:00.000Z");

describe("worker health state", () => {
  it("事件循环新鲜且浏览器就绪时通过两类探针", () => {
    const initial = createWorkerHealthState(startedAt);
    const browserReady = reduceWorkerHealthState(initial, {
      type: "browser-ready",
      at: startedAt + 1_000,
    });
    const progressed = reduceWorkerHealthState(browserReady, {
      type: "loop-progress",
      at: startedAt + 2_000,
    });

    expect(evaluateLiveness(progressed, startedAt + 10_000, 90_000)).toEqual({
      body: { status: "ok" },
      status: 200,
    });
    expect(evaluateReadiness(progressed)).toEqual({
      body: { status: "ready" },
      status: 200,
    });
  });

  it("事件循环超过阈值时 liveness 失败", () => {
    const state = createWorkerHealthState(startedAt);

    expect(evaluateLiveness(state, startedAt + 90_001, 90_000)).toEqual({
      body: { status: "stale" },
      status: 503,
    });
  });

  it("浏览器未就绪或开始关闭时 readiness 失败", () => {
    const initial = createWorkerHealthState(startedAt);
    const stopping = reduceWorkerHealthState(initial, {
      type: "shutdown-started",
      at: startedAt + 1_000,
    });

    expect(evaluateReadiness(initial).status).toBe(503);
    expect(evaluateReadiness(stopping)).toEqual({
      body: { status: "stopping" },
      status: 503,
    });
  });
});
