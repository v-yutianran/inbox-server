import { describe, expect, it, vi } from "vitest";

import { createQueueProducer } from "../src/queue-producer";

describe("Cloudflare Queue producer", () => {
  it.each([0, 1, 100, 101, 220])("按数量上限顺序发布 %i 条任务", async (count) => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const producer = createQueueProducer({ sendBatch } as unknown as Queue);
    const jobs = Array.from({ length: count }, (_, index) => textJob(index));

    await producer.sendBatch(jobs);

    expect(sendBatch).toHaveBeenCalledTimes(Math.ceil(count / 100));
    expect(sendBatch.mock.calls.flatMap(([batch]) => batch.map((message: { body: unknown }) => message.body))).toEqual(jobs);
    for (const [batch] of sendBatch.mock.calls) expect(batch.length).toBeLessThanOrEqual(100);
  });

  it("未满 100 条时也按 UTF-8 字节上限分批", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const producer = createQueueProducer({ sendBatch } as unknown as Queue);
    const jobs = Array.from({ length: 5 }, (_, index) => textJob(index, "中".repeat(20_000)));

    await producer.sendBatch(jobs);

    expect(sendBatch).toHaveBeenCalledTimes(2);
    for (const [batch] of sendBatch.mock.calls) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(256_000);
    }
    expect(sendBatch.mock.calls.flatMap(([batch]) => batch.map((message: { body: unknown }) => message.body))).toEqual(jobs);
  });

  it("后续有超大消息时在首次发布前拒绝整个输入", async () => {
    const sendBatch = vi.fn();
    const producer = createQueueProducer({ sendBatch } as unknown as Queue);

    await expect(producer.sendBatch([
      textJob(0),
      textJob(1, "中".repeat(50_000)),
    ])).rejects.toThrow("Queue message exceeds 128 KB");
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("第二批失败时传播原异常并停止后续发布", async () => {
    const failure = new Error("queue unavailable");
    const sendBatch = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const producer = createQueueProducer({ sendBatch } as unknown as Queue);

    await expect(producer.sendBatch(
      Array.from({ length: 220 }, (_, index) => textJob(index)),
    )).rejects.toBe(failure);
    expect(sendBatch).toHaveBeenCalledTimes(2);
  });

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

function textJob(index: number, content = `task ${index}`) {
  return {
    createdAt: "2026-10-10T01:00:00.000Z",
    dedupeKey: `dispatch:text:${index}`,
    jobId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    kind: "dispatch-item",
    payload: { content, itemKind: "text" },
    schemaVersion: 1,
  };
}
