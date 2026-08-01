import { describe, expect, it } from "vitest";

import {
  classifyJobFailure,
  decideJobSettlement,
  type JobFailure,
} from "../src/control-plane-contract";

describe("control plane job contract", () => {
  it.each([
    [new TypeError("fetch failed"), "retryable"],
    [new Error("Cloudflare Queues request failed: 503"), "retryable"],
    [new Error("invalid collector payload"), "permanent"],
  ] as const)("稳定分类错误 %#", (error, expected) => {
    expect(classifyJobFailure(error).errorClass).toBe(expected);
  });

  it.each([
    [{ attempts: 1, errorClass: "retryable" }, "retry"],
    [{ attempts: 3, errorClass: "retryable" }, "dead-letter"],
    [{ attempts: 1, errorClass: "permanent" }, "dead-letter"],
  ] as const)("仅对可恢复且未耗尽次数的任务重试 %#", (failure, expected) => {
    expect(decideJobSettlement(failure as JobFailure)).toBe(expected);
  });
});
