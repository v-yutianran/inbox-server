import { describe, expect, it, vi } from "vitest";

import { stageQueueBatch } from "../src/index";
import type { QueueInboxService } from "../src/queue-inbox";

describe("Cloudflare queue consumer", () => {
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
