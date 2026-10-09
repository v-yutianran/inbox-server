import { describe, expect, it, vi } from "vitest";

import { stageQueueBatch } from "../src/index";
import type { QueueInboxService } from "../src/queue-inbox";

describe("Cloudflare queue consumer", () => {
  it("冻结时抛错触发重试，且不持久化、唤醒或 ack", async () => {
    const ackAll = vi.fn();
    const stage = vi.fn().mockResolvedValue(undefined);
    const service = { stage } as unknown as QueueInboxService;
    const createQueueInboxService = vi.fn(() => service);
    const workerFetch = vi.fn<typeof fetch>();
    const batch = {
      ackAll,
      messages: [{ body: { schemaVersion: 1 }, id: "message-1", timestamp: new Date(0) }],
    } as unknown as Pick<MessageBatch<unknown>, "ackAll" | "messages">;

    await expect(
      stageQueueBatch(
        { MIGRATION_FROZEN: "true" } as never,
        batch,
        createQueueInboxService,
        workerFetch,
      ),
    ).rejects.toThrow("queue processing is paused for migration");

    expect(createQueueInboxService).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(workerFetch).not.toHaveBeenCalled();
    expect(ackAll).not.toHaveBeenCalled();
  });

  it.each([undefined, "false"])(
    "MIGRATION_FROZEN=%s 时保留现有 Queue 持久化与 ack 行为",
    async (migrationFrozen) => {
      const ackAll = vi.fn();
      const stage = vi.fn().mockResolvedValue(undefined);
      const service = { stage } as unknown as QueueInboxService;
      const batch = {
        ackAll,
        messages: [],
      } as unknown as Pick<MessageBatch<unknown>, "ackAll" | "messages">;

      await stageQueueBatch(
        { MIGRATION_FROZEN: migrationFrozen } as never,
        batch,
        () => service,
      );

      expect(stage).toHaveBeenCalledOnce();
      expect(ackAll).toHaveBeenCalledOnce();
    },
  );

  it("先持久化再唤醒 worker，且只在唤醒成功后 ack", async () => {
    const calls: string[] = [];
    const ackAll = vi.fn(() => calls.push("ack"));
    const stage = vi.fn(async () => { calls.push("stage"); });
    const service = { stage } as unknown as QueueInboxService;
    const workerFetch = vi.fn<typeof fetch>(async (input, init) => {
      calls.push("wake");
      expect(input).toBe("https://worker.example/webhooks/worker");
      expect(init).toMatchObject({
        method: "POST",
        headers: { Authorization: "Bearer synthetic-token" },
      });
      expect(ackAll).not.toHaveBeenCalled();
      return new Response(null, { status: 204 });
    });
    const batch = {
      ackAll,
      messages: [{ body: { schemaVersion: 1 }, id: "message-1", timestamp: new Date(0) }],
    } as unknown as Pick<MessageBatch<unknown>, "ackAll" | "messages">;

    await stageQueueBatch(
      {
        WORKER_WEBHOOK_URL: "https://worker.example/webhooks/worker",
        WORKER_WEBHOOK_TOKEN: "synthetic-token",
      } as never,
      batch,
      () => service,
      workerFetch,
    );

    expect(calls).toEqual(["stage", "wake", "ack"]);
  });

  it("唤醒失败时不 ack，重投沿用相同 message id", async () => {
    const ackAll = vi.fn();
    const stage = vi.fn().mockResolvedValue(undefined);
    const service = { stage } as unknown as QueueInboxService;
    const workerFetch = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("https://worker.example synthetic-token transport detail"))
      .mockResolvedValueOnce(
        new Response("https://worker.example synthetic-token response detail", { status: 503 }),
      );
    const batch = {
      ackAll,
      messages: [{ body: { schemaVersion: 1 }, id: "stable-message-id", timestamp: new Date(0) }],
    } as unknown as Pick<MessageBatch<unknown>, "ackAll" | "messages">;
    const bindings = {
      WORKER_WEBHOOK_URL: "https://worker.example/webhooks/worker",
      WORKER_WEBHOOK_TOKEN: "synthetic-token",
    } as never;

    await expect(stageQueueBatch(bindings, batch, () => service, workerFetch)).rejects.toThrow(
      "Worker webhook request failed",
    );
    await expect(stageQueueBatch(bindings, batch, () => service, workerFetch)).rejects.toThrow(
      "Worker webhook request failed",
    );

    expect(stage).toHaveBeenNthCalledWith(1, [
      { body: { schemaVersion: 1 }, id: "stable-message-id", timestampMs: 0 },
    ]);
    expect(stage).toHaveBeenNthCalledWith(2, [
      { body: { schemaVersion: 1 }, id: "stable-message-id", timestampMs: 0 },
    ]);
    expect(ackAll).not.toHaveBeenCalled();
  });

  it("半配置时失败且不唤醒或 ack", async () => {
    const ackAll = vi.fn();
    const stage = vi.fn().mockResolvedValue(undefined);
    const service = { stage } as unknown as QueueInboxService;
    const workerFetch = vi.fn<typeof fetch>();
    const batch = {
      ackAll,
      messages: [],
    } as unknown as Pick<MessageBatch<unknown>, "ackAll" | "messages">;

    await expect(
      stageQueueBatch(
        { WORKER_WEBHOOK_URL: "https://worker.example/webhooks/worker" } as never,
        batch,
        () => service,
        workerFetch,
      ),
    ).rejects.toThrow();

    expect(stage).toHaveBeenCalledOnce();
    expect(workerFetch).not.toHaveBeenCalled();
    expect(ackAll).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP", "http://worker.example/webhooks/worker"],
    ["内嵌用户名和密码", "https://user:password@worker.example/webhooks/worker"],
  ])("拒绝含%s的 webhook URL，不调用 fetch 或 ack", async (_label, url) => {
    const ackAll = vi.fn();
    const service = { stage: vi.fn().mockResolvedValue(undefined) } as unknown as QueueInboxService;
    const workerFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const batch = {
      ackAll,
      messages: [],
    } as unknown as Pick<MessageBatch<unknown>, "ackAll" | "messages">;

    await expect(
      stageQueueBatch(
        { WORKER_WEBHOOK_URL: url, WORKER_WEBHOOK_TOKEN: "synthetic-token" } as never,
        batch,
        () => service,
        workerFetch,
      ),
    ).rejects.toThrow("Worker webhook URL must use HTTPS without credentials");

    expect(workerFetch).not.toHaveBeenCalled();
    expect(ackAll).not.toHaveBeenCalled();
  });

  it("仅在 D1 收件箱持久化成功后 ack Cloudflare batch", async () => {
    const ackAll = vi.fn();
    const stage = vi.fn().mockResolvedValue(undefined);
    const service = { stage } as unknown as QueueInboxService;
    const batch = {
      ackAll,
      messages: [
        {
          body: { schemaVersion: 1 },
          id: "message-1",
          timestamp: new Date("2026-08-01T04:00:00.000Z"),
        },
      ],
    } as unknown as Pick<MessageBatch<unknown>, "ackAll" | "messages">;

    await stageQueueBatch({} as never, batch, () => service);

    expect(stage).toHaveBeenCalledWith([
      { body: { schemaVersion: 1 }, id: "message-1", timestampMs: 1_785_556_800_000 },
    ]);
    expect(ackAll).toHaveBeenCalledOnce();
  });

  it("D1 持久化失败时不 ack，让 Cloudflare 自动重试", async () => {
    const ackAll = vi.fn();
    const service = {
      stage: vi.fn().mockRejectedValue(new Error("D1 unavailable")),
    } as unknown as QueueInboxService;

    await expect(
      stageQueueBatch(
        {} as never,
        { ackAll, messages: [] } as unknown as Pick<
          MessageBatch<unknown>,
          "ackAll" | "messages"
        >,
        () => service,
      ),
    ).rejects.toThrow("D1 unavailable");
    expect(ackAll).not.toHaveBeenCalled();
  });
});
