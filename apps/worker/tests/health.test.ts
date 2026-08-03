import { describe, expect, it } from "vitest";

import {
  createWorkerHealthState,
  decideJobAcceptance,
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

    expect(evaluateLiveness(progressed, startedAt + 10_000, 90_000)).toMatchObject({
      body: { phase: "ready", status: "ok" },
      status: 200,
    });
    expect(evaluateReadiness(progressed)).toMatchObject({
      body: {
        canAcceptWork: true,
        components: { browser: { state: "ready" } },
        phase: "ready",
        status: "ready",
      },
      status: 200,
    });
  });

  it("长任务超过进度阈值时 liveness 仍表示进程存活", () => {
    const state = createWorkerHealthState(startedAt);

    expect(evaluateLiveness(state, startedAt + 90_001, 90_000)).toMatchObject({
      body: { status: "ok" },
      status: 200,
    });
  });

  it("控制面暂时失败时仍刷新事件循环存活时间", () => {
    const state = reduceWorkerHealthState(createWorkerHealthState(startedAt), {
      type: "loop-error",
      at: startedAt + 80_000,
    });

    expect(evaluateLiveness(state, startedAt + 100_000, 90_000)).toMatchObject({
      body: { status: "ok" },
      status: 200,
    });
  });

  it("浏览器未就绪或开始关闭时 readiness 失败", () => {
    const initial = createWorkerHealthState(startedAt);
    const stopping = reduceWorkerHealthState(initial, {
      type: "shutdown-started",
      at: startedAt + 1_000,
    });

    expect(evaluateReadiness(initial).status).toBe(503);
    expect(evaluateReadiness(stopping)).toMatchObject({
      body: { canAcceptWork: false, phase: "stopping", status: "stopping" },
      status: 503,
    });
  });

  it("分别暴露浏览器、Mihomo 与 WARP 状态，并由必需依赖收敛 Worker phase", () => {
    const initial = createWorkerHealthState(startedAt, {
      mihomoRequired: true,
      warpRequired: true,
    });
    const ready = ["warp", "mihomo", "browser"].reduce(
      (state, component) =>
        reduceWorkerHealthState(state, {
          at: startedAt + 1_000,
          component: component as "browser" | "mihomo" | "warp",
          reasonCode: "probe_succeeded",
          state: "ready",
          type: "component-state",
        }),
      initial,
    );

    expect(evaluateReadiness(ready)).toMatchObject({
      body: {
        components: {
          browser: { canAcceptWork: true, reasonCode: "probe_succeeded", state: "ready" },
          mihomo: { canAcceptWork: true, reasonCode: "probe_succeeded", state: "ready" },
          warp: { canAcceptWork: true, reasonCode: "probe_succeeded", state: "ready" },
        },
        phase: "ready",
      },
      status: 200,
    });

    const degraded = reduceWorkerHealthState(ready, {
      at: startedAt + 2_000,
      component: "warp",
      reasonCode: "tcp_probe_failed",
      state: "degraded",
      type: "component-state",
    });
    expect(evaluateReadiness(degraded)).toMatchObject({
      body: { canAcceptWork: false, phase: "degraded", status: "degraded" },
      status: 503,
    });
  });

  it("浏览器故障只延期依赖浏览器的任务，代理故障停止所有外部任务领取", () => {
    const ready = reduceWorkerHealthState(createWorkerHealthState(startedAt), {
      at: startedAt + 1_000,
      type: "browser-ready",
    });
    const browserDown = reduceWorkerHealthState(ready, {
      at: startedAt + 2_000,
      component: "browser",
      reasonCode: "disconnected",
      state: "degraded",
      type: "component-state",
    });
    const linkJob = {
      createdAt: "2026-08-03T00:00:00.000Z",
      dedupeKey: "dispatch:link:test",
      jobId: "6bcb6276-a48e-43ea-a037-59b66120b754",
      kind: "dispatch-item" as const,
      payload: { itemKind: "link" as const, url: "https://example.com" },
      schemaVersion: 1 as const,
    };
    const articleJob = {
      ...linkJob,
      dedupeKey: "dispatch:article:test",
      jobId: "7f922fdd-f60d-4f1b-8f69-84885532217c",
      payload: {
        itemKind: "article" as const,
        requestedAt: "2026-08-03T00:00:00.000Z",
        url: "https://example.com/article",
      },
    };

    expect(decideJobAcceptance(browserDown, linkJob)).toEqual({ action: "accept" });
    expect(decideJobAcceptance(browserDown, articleJob)).toMatchObject({
      action: "defer",
      reasonCode: "browser_unready",
    });

    const proxyReady = reduceWorkerHealthState(
      createWorkerHealthState(startedAt, { warpRequired: true }),
      { at: startedAt + 1_000, type: "browser-ready" },
    );
    expect(decideJobAcceptance(proxyReady, linkJob)).toMatchObject({
      action: "defer",
      reasonCode: "warp_unready",
    });
  });
});
