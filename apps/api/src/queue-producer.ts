import { parseQueueJob, type QueueJob } from "@inbox/domain";

export interface QueueProducer {
  sendBatch(inputs: readonly unknown[]): Promise<void>;
}

/** 在发布任何消息前先验证完整批次，避免部分写入未知版本。 */
export function createQueueProducer(queue: Queue<QueueJob>): QueueProducer {
  return {
    async sendBatch(inputs) {
      const encoder = new TextEncoder();
      const messages = inputs.map((input) => {
        const body = parseQueueJob(input);
        // 平台还会附加约 100 字节元数据，预留后再判断单条和批次上限。
        const bytes = encoder.encode(JSON.stringify(body)).byteLength + 100;
        if (bytes > 128_000) throw new Error("Queue message exceeds 128 KB");
        return { body, bytes };
      });
      let batch: { body: QueueJob }[] = [];
      let batchBytes = 0;
      for (const { body, bytes } of messages) {
        if (batch.length === 100 || batchBytes + bytes > 256_000) {
          await queue.sendBatch(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push({ body });
        batchBytes += bytes;
      }
      if (batch.length > 0) await queue.sendBatch(batch);
    },
  };
}
