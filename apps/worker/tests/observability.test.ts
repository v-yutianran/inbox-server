import { describe, expect, it } from "vitest";

import {
  createRuntimeMetrics,
  reduceRuntimeMetrics,
  runtimeMetricsSnapshot,
  sanitizeLogContext,
} from "../src/observability";

describe("worker observability", () => {
  it("只按稳定事件聚合低基数任务结果与提取路径", () => {
    const events = [
      "article.extract.direct.rejected",
      "article.extract.browser.succeeded",
      "worker.job.succeeded",
      "worker.job.retryable_failed",
      "unknown.event",
    ];
    const metrics = events.reduce(reduceRuntimeMetrics, createRuntimeMetrics());

    expect(runtimeMetricsSnapshot(metrics)).toEqual({
      articleExtraction: {
        browserSucceeded: 1,
        directRejected: 1,
        directSucceeded: 0,
        failed: 0,
      },
      jobResults: {
        deadLettered: 0,
        deferred: 0,
        retryableFailed: 1,
        succeeded: 1,
        uncertain: 0,
      },
    });
  });

  it("日志上下文递归过滤敏感字段和值", () => {
    const context = sanitizeLogContext({
      error: "authorization=Bearer raw-auth cookie=session-value",
      nested: { password: "raw-password" },
      serviceToken: "raw-token",
      stable: "visible",
    });
    const serialized = JSON.stringify(context);

    expect(context).toMatchObject({
      nested: { password: "[redacted]" },
      serviceToken: "[redacted]",
      stable: "visible",
    });
    expect(serialized).not.toContain("raw-auth");
    expect(serialized).not.toContain("session-value");
    expect(serialized).not.toContain("raw-password");
    expect(serialized).not.toContain("raw-token");
  });
});
