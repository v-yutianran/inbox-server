import { describe, expect, it, vi } from "vitest";

import { runBrowserBatch } from "../src/browser";
import { createWorkerHealthState } from "../src/health";
import {
  createWorkerWebhookHandler,
  handleHealthRequest,
} from "../src/health-server";

describe("worker webhook trigger", () => {
  it("routes only the configured worker path and leaves unknown paths at 404", async () => {
    const processBatch = vi.fn().mockResolvedValue(0);
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => "ready",
      log: vi.fn(),
      processBatch,
      token: "trigger-token",
    });
    const options = {
      getState: () => createWorkerHealthState(Date.now()),
      staleAfterMs: 90_000,
      webhook,
    };

    await expect(handleHealthRequest(options, {
      authorization: "Bearer trigger-token",
      method: "POST",
      url: "/webhooks/worker",
    })).resolves.toMatchObject({ body: { status: "ok" }, status: 200 });
    await expect(handleHealthRequest(options, {
      authorization: "Bearer trigger-token",
      method: "POST",
      url: "/unknown",
    })).resolves.toMatchObject({ body: { status: "not_found" }, status: 404 });
    await expect(handleHealthRequest({
      getState: options.getState,
      staleAfterMs: options.staleAfterMs,
    }, {
      authorization: "Bearer trigger-token",
      method: "POST",
      url: "/webhooks/worker",
    })).resolves.toMatchObject({ body: { status: "not_found" }, status: 404 });
    expect(processBatch).toHaveBeenCalledTimes(1);
  });

  it("serially drains every due batch and returns success only after an empty pull", async () => {
    let finishFirstBatch!: (messageCount: number) => void;
    const firstBatch = new Promise<number>((resolve) => { finishFirstBatch = resolve; });
    const processBatch = vi.fn()
      .mockReturnValueOnce(firstBatch)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => "ready",
      log: vi.fn(),
      processBatch,
      token: "trigger-token",
    });

    const response = webhook({ method: "POST", authorization: "Bearer trigger-token" });
    await Promise.resolve();
    expect(processBatch).toHaveBeenCalledTimes(1);
    finishFirstBatch(2);

    await expect(response)
      .resolves.toMatchObject({ body: { status: "ok" }, status: 200 });
    expect(processBatch).toHaveBeenCalledTimes(3);
    expect(processBatch.mock.invocationCallOrder[0]).toBeLessThan(processBatch.mock.invocationCallOrder[1]!);
    expect(processBatch.mock.invocationCallOrder[1]).toBeLessThan(processBatch.mock.invocationCallOrder[2]!);
  });

  it("returns retryable 503 when the drain budget expires before an empty pull", async () => {
    let now = 0;
    const processBatch = vi.fn(async () => {
      now = 720_000;
      return 1;
    });
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => "ready",
      log: vi.fn(),
      now: () => now,
      processBatch,
      token: "trigger-token",
    });

    await expect(webhook({ method: "POST", authorization: "Bearer trigger-token" }))
      .resolves.toMatchObject({
        body: { status: "unavailable" },
        retryAfterSeconds: 5,
        status: 503,
      });
    expect(processBatch).toHaveBeenCalledTimes(1);
  });

  it("does not start another batch after the worker begins stopping", async () => {
    let availability: "ready" | "stopping" = "ready";
    const processBatch = vi.fn().mockImplementationOnce(async () => {
      availability = "stopping";
      return 1;
    }).mockResolvedValueOnce(0);
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => availability,
      log: vi.fn(),
      processBatch,
      token: "trigger-token",
    });

    await expect(webhook({ method: "POST", authorization: "Bearer trigger-token" }))
      .resolves.toMatchObject({
        body: { status: "unavailable" },
        retryAfterSeconds: 5,
        status: 503,
      });
    expect(processBatch).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthorized calls and methods without processing a batch", async () => {
    const processBatch = vi.fn().mockResolvedValue(0);
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => "ready",
      log: vi.fn(),
      processBatch,
      token: "trigger-token",
    });

    await expect(webhook({ method: "POST", authorization: undefined })).resolves.toMatchObject({
      body: { status: "unauthorized" },
      status: 401,
    });
    await expect(webhook({ method: "POST", authorization: "Bearer wrong-token" })).resolves.toMatchObject({
      body: { status: "unauthorized" },
      status: 401,
    });
    await expect(webhook({ method: "GET", authorization: "Bearer trigger-token" })).resolves.toMatchObject({
      body: { status: "method_not_allowed" },
      status: 405,
    });

    expect(processBatch).not.toHaveBeenCalled();
  });

  it("waits for processing and settlement, rejecting overlapping triggers for retry", async () => {
    let finishFirst!: () => void;
    const pending = new Promise<number>((resolve) => { finishFirst = () => resolve(0); });
    const processBatch = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(0);
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => "ready",
      log: vi.fn(),
      processBatch,
      token: "trigger-token",
    });
    const request = { method: "POST", authorization: "Bearer trigger-token" };

    let firstFinished = false;
    const first = webhook(request).then((result) => {
      firstFinished = true;
      return result;
    });
    await Promise.resolve();
    await expect(webhook(request)).resolves.toMatchObject({
      body: { status: "unavailable" },
      retryAfterSeconds: 5,
      status: 503,
    });
    expect(processBatch).toHaveBeenCalledTimes(1);
    expect(firstFinished).toBe(false);

    finishFirst();
    await expect(first).resolves.toMatchObject({ body: { status: "ok" }, status: 200 });
    await expect(webhook(request)).resolves.toMatchObject({ body: { status: "ok" }, status: 200 });
  });

  it("rejects unavailable workers and hides dependency errors from response and logs", async () => {
    const log = vi.fn();
    const processBatch = vi.fn()
      .mockRejectedValueOnce(new Error("dependency secret=trigger-token"))
      .mockResolvedValue(0);
    const unavailable = createWorkerWebhookHandler({
      getAvailability: () => "stopping",
      log,
      processBatch,
      token: "trigger-token",
    });
    const request = { method: "POST", authorization: "Bearer trigger-token" };

    await expect(unavailable(request)).resolves.toMatchObject({
      body: { status: "unavailable" },
      retryAfterSeconds: 5,
      status: 503,
    });
    expect(processBatch).not.toHaveBeenCalled();

    const failing = createWorkerWebhookHandler({
      getAvailability: () => "ready",
      log,
      processBatch,
      token: "trigger-token",
    });
    const response = await failing(request);
    expect(response).toMatchObject({
      body: { status: "unavailable" },
      retryAfterSeconds: 5,
      status: 503,
    });
    expect(JSON.stringify({ log: log.mock.calls, response })).not.toContain("trigger-token");
    expect(log).toHaveBeenCalledWith("worker.webhook.failed", expect.objectContaining({ status: 503 }));
    await expect(failing(request)).resolves.toMatchObject({ body: { status: "ok" }, status: 200 });
    expect(processBatch).toHaveBeenCalledTimes(2);
  });

  it("rejects valid triggers until the worker is ready", async () => {
    const processBatch = vi.fn();
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => "not_ready",
      log: vi.fn(),
      processBatch,
      token: "trigger-token",
    });

    await expect(webhook({
      method: "POST",
      authorization: "Bearer trigger-token",
    })).resolves.toMatchObject({
      body: { status: "unavailable" },
      retryAfterSeconds: 5,
      status: 503,
    });
    expect(processBatch).not.toHaveBeenCalled();
  });

  it("browser connection failure returns retryable 503 before queue settlement", async () => {
    const settle = vi.fn();
    const webhook = createWorkerWebhookHandler({
      getAvailability: () => "ready",
      log: vi.fn(),
      processBatch: () => runBrowserBatch(
        true,
        async () => { throw new Error("remote browser unavailable"); },
        async () => { await settle(); return 0; },
      ),
      token: "trigger-token",
    });

    await expect(webhook({
      method: "POST",
      authorization: "Bearer trigger-token",
    })).resolves.toMatchObject({ status: 503, body: { status: "unavailable" } });
    expect(settle).not.toHaveBeenCalled();
  });
});
