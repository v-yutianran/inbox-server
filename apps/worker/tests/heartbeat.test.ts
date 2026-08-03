import { describe, expect, it, vi } from "vitest";

import { runHeartbeatLoop } from "../src/heartbeat";

describe("worker heartbeat loop", () => {
  it("长任务执行期间按独立周期持续发送心跳", async () => {
    const abortController = new AbortController();
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockImplementation(async () => {
      if (heartbeat.mock.calls.length >= 3) abortController.abort();
    });

    await runHeartbeatLoop({
      controlPlane: { heartbeat },
      details: () => ({ backlogCount: 7, browserReady: true, processingEnabled: true }),
      intervalMs: 30_000,
      onError: vi.fn(),
      signal: abortController.signal,
      wait,
      workerId: "worker-1",
    });

    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(heartbeat).toHaveBeenLastCalledWith("worker-1", {
      backlogCount: 7,
      browserReady: true,
      processingEnabled: true,
    });
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("单次心跳失败后记录错误并继续下一周期", async () => {
    const abortController = new AbortController();
    const heartbeat = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const wait = vi.fn().mockImplementation(async () => {
      if (heartbeat.mock.calls.length >= 2) abortController.abort();
    });

    await runHeartbeatLoop({
      controlPlane: { heartbeat },
      details: () => ({ backlogCount: 0 }),
      intervalMs: 30_000,
      onError,
      signal: abortController.signal,
      wait,
      workerId: "worker-1",
    });

    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
