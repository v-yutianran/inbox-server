import { describe, expect, it } from "vitest";

import {
  calculateRetryDelaySeconds,
  decideJobTransition,
  decideRateLimitBatch,
} from "../src/job-retry-policy";

const now = new Date("2030-01-01T00:00:00.000Z");

describe("job retry policy", () => {
  it("将超过 Queue 上限的绝对延期拆成最多 300 秒", () => {
    expect(calculateRetryDelaySeconds("2030-01-01T00:15:01.000Z", now)).toBe(300);
    expect(calculateRetryDelaySeconds("2030-01-01T00:00:07.100Z", now)).toBe(8);
    expect(calculateRetryDelaySeconds("2029-12-31T23:59:59.000Z", now)).toBe(1);
  });

  it("任一窗口拒绝时返回最晚 retryAt 且不部分扣减", () => {
    const currentStates = [
      {
        bucketKey: "2030-01-01",
        count: 4,
        expiresAt: "2030-01-02T00:00:00.000Z",
        scope: "article:daily",
      },
      {
        bucketKey: "window-1",
        count: 2,
        expiresAt: "2030-01-01T00:10:00.000Z",
        scope: "article:window",
      },
    ];
    const result = decideRateLimitBatch(
      [
        { bucketKey: "2030-01-01", limit: 10, scope: "article:daily", windowSeconds: 86_400 },
        { bucketKey: "window-1", limit: 2, scope: "article:window", windowSeconds: 600 },
      ],
      currentStates,
      now,
    );

    expect(result).toEqual({
      allowed: false,
      counts: { "article:daily": 4, "article:window": 2 },
      nextStates: currentStates,
      retryAt: "2030-01-01T00:10:00.000Z",
    });
  });

  it("所有窗口允许时一次生成完整的下一状态", () => {
    const result = decideRateLimitBatch(
      [
        { bucketKey: "2030-01-01", limit: 10, scope: "article:daily", windowSeconds: 86_400 },
        { bucketKey: "window-1", limit: 2, scope: "article:window", windowSeconds: 600 },
      ],
      [],
      now,
    );

    expect(result.allowed).toBe(true);
    expect(result.counts).toEqual({ "article:daily": 1, "article:window": 1 });
    expect(result.nextStates).toHaveLength(2);
  });

  it("只有真实失败增加 failureAttempts，延期保持失败预算", () => {
    expect(
      decideJobTransition(
        { failureAttempts: 2, status: "processing" },
        { kind: "deferred" },
      ),
    ).toEqual({ failureAttempts: 2, status: "deferred" });
    expect(
      decideJobTransition(
        { failureAttempts: 2, status: "processing" },
        { errorClass: "retryable", kind: "failed" },
      ),
    ).toEqual({ failureAttempts: 3, status: "dead" });
    expect(
      decideJobTransition(
        { failureAttempts: 0, status: "processing" },
        { errorClass: "permanent", kind: "failed" },
      ),
    ).toEqual({ failureAttempts: 1, status: "dead" });
  });
});
