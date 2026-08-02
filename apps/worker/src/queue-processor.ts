import {
  classifyJobFailure,
  parseQueueJob,
  type QueueJob,
} from "@inbox/domain";

import type {
  CloudflareQueueClient,
  QueueBatch,
  QueueSettlement,
} from "./cloudflare-queue-client.js";
import type { WorkerControlPlane } from "./worker-control-plane.js";

type JsonRecord = Readonly<Record<string, unknown>>;

interface ProcessQueueBatchOptions {
  readonly batch: QueueBatch;
  readonly controlPlane: WorkerControlPlane;
  readonly handle: (job: QueueJob) => Promise<JsonRecord>;
  readonly log?: (event: string, context: JsonRecord) => void;
  readonly onProgress?: () => void;
  readonly queue: CloudflareQueueClient;
}

/** 先落 D1 终态再结算 Cloudflare lease，进程崩溃只会导致安全的幂等重放。 */
export async function processQueueBatch({
  batch,
  controlPlane,
  handle,
  log,
  onProgress,
  queue,
}: ProcessQueueBatchOptions): Promise<void> {
  const settlement: { acks: string[]; retries: Array<{ delaySeconds?: number; leaseId: string }> } = {
    acks: [],
    retries: [],
  };

  for (const lease of batch.messages) {
    try {
      let job: QueueJob;
      try {
        job = parseQueueJob(lease.body);
      } catch (error: unknown) {
        const failure = classifyJobFailure(error);
        await controlPlane.rejectInvalidJob({
          attempts: lease.attempts,
          messageId: lease.id,
          payloadDigest: await digestPayload(lease.body),
          reason: failure.safeMessage,
        });
        settlement.acks.push(lease.leaseId);
        continue;
      }

      const claim = await controlPlane.claimJob(job);
      if (claim.state === "duplicate") {
        settlement.acks.push(lease.leaseId);
        continue;
      }
      if (claim.state === "busy") {
        settlement.retries.push({ delaySeconds: 30, leaseId: lease.leaseId });
        continue;
      }

      const startedAt = Date.now();
      try {
        const summary = await handle(job);
        const result = await controlPlane.finishJob(job.jobId, { status: "done", summary });
        appendSettlement(settlement, lease.leaseId, result);
        log?.("worker.job.succeeded", {
          attempts: lease.attempts,
          description: "队列任务处理成功",
          durationMs: Date.now() - startedAt,
          jobId: job.jobId,
          kind: job.kind,
          settlement: result.settlement,
          ...(job.kind === "collect-source" ? { source: job.payload.source } : {}),
        });
      } catch (error: unknown) {
        const failure = classifyJobFailure(error);
        const result = await controlPlane.finishJob(job.jobId, {
          errorClass: failure.errorClass,
          errorMessage: failure.safeMessage,
          payloadDigest: await digestPayload(lease.body),
          status: "failed",
        });
        appendSettlement(settlement, lease.leaseId, result);
        log?.("worker.job.failed", {
          attempts: lease.attempts,
          description: "队列任务处理失败",
          durationMs: Date.now() - startedAt,
          errorClass: failure.errorClass,
          errorMessage: failure.safeMessage,
          jobId: job.jobId,
          kind: job.kind,
          settlement: result.settlement,
          ...(job.kind === "collect-source" ? { source: job.payload.source } : {}),
        });
      }
    } finally {
      onProgress?.();
    }
  }

  await queue.settle(settlement satisfies QueueSettlement);
}

function appendSettlement(
  settlement: { acks: string[]; retries: Array<{ delaySeconds?: number; leaseId: string }> },
  leaseId: string,
  result: { delaySeconds?: number | undefined; settlement: "ack" | "retry" },
): void {
  if (result.settlement === "ack") settlement.acks.push(leaseId);
  else {
    settlement.retries.push(
      result.delaySeconds === undefined
        ? { leaseId }
        : { delaySeconds: result.delaySeconds, leaseId },
    );
  }
}

async function digestPayload(payload: unknown): Promise<string> {
  const serialized = JSON.stringify(payload) ?? String(payload);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
