import { describe, expect, it, vi } from "vitest";

import { createQueueProducer } from "../src/queue-producer";

describe("Cloudflare Queue producer", () => {
  it("发布前拒绝未知版本，且不会部分写入", async () => {
    const sendBatch = vi.fn();
    const queue = { sendBatch } as unknown as Queue;
    const producer = createQueueProducer(queue);

    await expect(
      producer.sendBatch([
        {
          createdAt: "2026-08-01T02:50:00.000Z",
          dedupeKey: "collect:telegram:job",
          jobId: "6b7cb870-cae5-43cf-a4cb-ec9706198225",
          kind: "collect-source",
          payload: { shadow: true, source: "telegram", triggeredBy: "manual" },
          schemaVersion: 1,
        },
        { kind: "unknown", schemaVersion: 2 },
      ]),
    ).rejects.toThrow();
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
