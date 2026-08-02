import { describe, expect, it, vi } from "vitest";

import type { QueueJob } from "@inbox/domain";

import { processQueueBatch } from "../src/queue-processor";
import type { WorkerControlPlane } from "../src/worker-control-plane";
import type {
  CloudflareQueueClient,
  QueueBatch,
} from "../src/cloudflare-queue-client";

const job: QueueJob = {
  createdAt: "2026-08-01T03:00:00.000Z",
  dedupeKey: "collect:telegram:test",
  jobId: "0f868f15-3b77-4ac8-90d9-f7b59c9721ee",
  kind: "collect-source",
  payload: { shadow: true, source: "telegram", triggeredBy: "shadow" },
  schemaVersion: 1,
};

function createBatch(body: unknown = job, attempts = 1): QueueBatch {
  return {
    backlogCount: 0,
    messages: [
      {
        attempts,
        body,
        id: "message-1",
        leaseId: "lease-1",
        timestampMs: Date.parse(job.createdAt),
      },
    ],
  };
}

function createQueue(): CloudflareQueueClient {
  return {
    pull: vi.fn(),
    settle: vi.fn().mockResolvedValue(undefined),
  };
}

function createControlPlane(): WorkerControlPlane {
  return {
    claimEffect: vi.fn(),
    claimJob: vi.fn().mockResolvedValue({ attempts: 1, state: "claimed" }),
    consumeRateLimit: vi.fn(),
    consumeRateLimits: vi.fn(),
    finishEffect: vi.fn(),
    finishJob: vi.fn().mockResolvedValue({ settlement: "ack" }),
    getCredential: vi.fn(),
    getState: vi.fn(),
    heartbeat: vi.fn(),
    publishJobs: vi.fn(),
    putLoginSession: vi.fn(),
    putState: vi.fn(),
    recordArticleEvent: vi.fn(),
    rejectInvalidJob: vi.fn(),
  };
}

describe("queue processor", () => {
  it("类型化延期不进入失败分类并按控制面 retryAt 结算", async () => {
    const queue = createQueue();
    const controlPlane = createControlPlane();
    const log = vi.fn();
    vi.mocked(controlPlane.finishJob).mockResolvedValue({
      delaySeconds: 300,
      settlement: "retry",
    });

    await processQueueBatch({
      batch: createBatch(),
      controlPlane,
      handle: vi.fn().mockResolvedValue({
        outcome: "deferred",
        reason: "rate_limit",
        retryAt: "2030-01-01T00:15:01.000Z",
      }),
      log,
      queue,
    });

    expect(controlPlane.finishJob).toHaveBeenCalledWith(job.jobId, {
      reason: "rate_limit",
      retryAt: "2030-01-01T00:15:01.000Z",
      status: "deferred",
    });
    expect(queue.settle).toHaveBeenCalledWith({
      acks: [],
      retries: [{ delaySeconds: 300, leaseId: "lease-1" }],
    });
    expect(log).toHaveBeenCalledWith(
      "worker.job.deferred",
      expect.not.objectContaining({ body: expect.anything(), payload: expect.anything() }),
    );
  });

  it("effect busy 记录专用无损延期事件且不记录真实失败", async () => {
    const queue = createQueue();
    const controlPlane = createControlPlane();
    const log = vi.fn();
    vi.mocked(controlPlane.finishJob).mockResolvedValue({
      delaySeconds: 300,
      settlement: "retry",
    });

    await processQueueBatch({
      batch: createBatch(),
      controlPlane,
      handle: vi.fn().mockResolvedValue({
        outcome: "deferred",
        reason: "effect_busy",
        retryAt: "2030-01-01T00:15:01.000Z",
      }),
      log,
      queue,
    });

    expect(log).toHaveBeenCalledWith(
      "worker.effect.busy.deferred",
      expect.objectContaining({ jobId: job.jobId, reason: "effect_busy" }),
    );
    expect(log).not.toHaveBeenCalledWith(
      "worker.job.retryable_failed",
      expect.anything(),
    );
  });

  it("只有 D1 完成状态持久化成功后才 ack", async () => {
    const queue = createQueue();
    const controlPlane = createControlPlane();
    vi.mocked(controlPlane.finishJob).mockRejectedValue(new Error("D1 unavailable"));

    await expect(
      processQueueBatch({
        batch: createBatch(),
        controlPlane,
        handle: vi.fn().mockResolvedValue({
          outcome: "completed",
          summary: { collected: 0 },
        }),
        queue,
      }),
    ).rejects.toThrow("D1 unavailable");

    expect(queue.settle).not.toHaveBeenCalled();
  });

  it("幂等命中直接 ack，不重复执行业务", async () => {
    const queue = createQueue();
    const controlPlane = createControlPlane();
    vi.mocked(controlPlane.claimJob).mockResolvedValue({ state: "duplicate" });
    const handle = vi.fn();

    await processQueueBatch({ batch: createBatch(), controlPlane, handle, queue });

    expect(handle).not.toHaveBeenCalled();
    expect(queue.settle).toHaveBeenCalledWith({ acks: ["lease-1"], retries: [] });
  });

  it("长批次在每条 lease 结束后刷新存活进度", async () => {
    const queue = createQueue();
    const controlPlane = createControlPlane();
    const first = createBatch().messages[0]!;
    const onProgress = vi.fn();

    await processQueueBatch({
      batch: {
        backlogCount: 0,
        messages: [
          first,
          { ...first, id: "message-2", leaseId: "lease-2" },
        ],
      },
      controlPlane,
      handle: vi.fn().mockResolvedValue({
        outcome: "completed",
        summary: { collected: 0 },
      }),
      onProgress,
      queue,
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("在 D1 终态落盘后记录可关联的任务结果日志", async () => {
    const queue = createQueue();
    const controlPlane = createControlPlane();
    const log = vi.fn();

    await processQueueBatch({
      batch: createBatch(),
      controlPlane,
      handle: vi.fn().mockResolvedValue({
        outcome: "completed",
        summary: { collected: 0 },
      }),
      log,
      queue,
    });

    expect(log).toHaveBeenCalledWith(
      "worker.job.succeeded",
      expect.objectContaining({
        description: "队列任务处理成功",
        jobId: job.jobId,
        kind: job.kind,
        source: "telegram",
      }),
    );

    vi.mocked(controlPlane.claimJob).mockResolvedValue({ attempts: 2, state: "claimed" });
    vi.mocked(controlPlane.finishJob).mockResolvedValue({
      delaySeconds: 30,
      settlement: "retry",
    });
    await processQueueBatch({
      batch: createBatch(job, 2),
      controlPlane,
      handle: vi.fn().mockRejectedValue(new TypeError("browser source timeout")),
      log,
      queue,
    });

    expect(log).toHaveBeenCalledWith(
      "worker.job.retryable_failed",
      expect.objectContaining({
        description: "队列任务真实失败，等待重试",
        errorMessage: "browser source timeout",
        jobId: job.jobId,
        kind: job.kind,
        source: "telegram",
      }),
    );
  });

  it("可恢复错误按控制面决策 retry，确定性错误入 D1 死信后 ack", async () => {
    const queue = createQueue();
    const controlPlane = createControlPlane();
    vi.mocked(controlPlane.finishJob)
      .mockResolvedValueOnce({ delaySeconds: 30, settlement: "retry" })
      .mockResolvedValueOnce({ settlement: "ack" });
    const networkError = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"));

    await processQueueBatch({
      batch: createBatch(job, 1),
      controlPlane,
      handle: networkError,
      queue,
    });
    expect(queue.settle).toHaveBeenLastCalledWith({
      acks: [],
      retries: [{ delaySeconds: 30, leaseId: "lease-1" }],
    });

    vi.mocked(controlPlane.claimJob).mockResolvedValue({ attempts: 3, state: "claimed" });
    const invalidError = vi.fn().mockRejectedValue(new Error("invalid collector payload"));
    await processQueueBatch({
      batch: createBatch(job, 3),
      controlPlane,
      handle: invalidError,
      queue,
    });
    expect(controlPlane.finishJob).toHaveBeenLastCalledWith(
      job.jobId,
      expect.objectContaining({
        errorClass: "permanent",
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: "failed",
      }),
    );
    expect(queue.settle).toHaveBeenLastCalledWith({ acks: ["lease-1"], retries: [] });
  });
});
