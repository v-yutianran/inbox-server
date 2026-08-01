import { parseQueueJob, type QueueJob } from "@inbox/domain";

export interface QueueProducer {
  sendBatch(inputs: readonly unknown[]): Promise<void>;
}

/** 在发布任何消息前先验证完整批次，避免部分写入未知版本。 */
export function createQueueProducer(queue: Queue<QueueJob>): QueueProducer {
  return {
    async sendBatch(inputs) {
      const jobs = inputs.map((input) => parseQueueJob(input));
      if (jobs.length === 0) return;
      await queue.sendBatch(jobs.map((body) => ({ body })));
    },
  };
}
