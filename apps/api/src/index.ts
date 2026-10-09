import { createApp, isMigrationFrozen } from "./app.js";
import type { ApiBindings } from "./auth.js";
import {
  createOperationsServiceFromBindings,
  type OperationsService,
} from "./operations.js";
import {
  createOperationsReadinessServiceFromBindings,
  type OperationsReadinessService,
} from "./operations-readiness.js";
import {
  createQueueInboxServiceFromBindings,
  type QueueInboxService,
} from "./queue-inbox.js";

const app = createApp();

async function wakeWorker(bindings: ApiBindings, workerFetch: typeof fetch): Promise<void> {
  const url = bindings.WORKER_WEBHOOK_URL?.trim();
  const token = bindings.WORKER_WEBHOOK_TOKEN?.trim();
  if (!url && !token) return;
  if (!url || !token) throw new Error("Worker webhook configuration incomplete");

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("Worker webhook URL must use HTTPS without credentials");
  }
  if (target.protocol !== "https:" || target.username || target.password) {
    throw new Error("Worker webhook URL must use HTTPS without credentials");
  }

  try {
    const response = await workerFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return;
  } catch {
    // Keep transport details and credentials out of Queue and Cron errors.
  }
  throw new Error("Worker webhook request failed");
}

export async function publishScheduledCollection(
  bindings: ApiBindings,
  createOperationsService: (bindings: ApiBindings) => OperationsService =
    createOperationsServiceFromBindings,
  createOperationsReadinessService: (
    bindings: ApiBindings,
  ) => OperationsReadinessService = createOperationsReadinessServiceFromBindings,
  workerFetch: typeof fetch = fetch,
): Promise<void> {
  if (isMigrationFrozen(bindings)) return;

  const wake = wakeWorker(bindings, workerFetch).catch(() => {
    console.error(JSON.stringify({
      event: "worker.webhook.wake_failed",
      service: "api",
      trigger: "cron",
    }));
  });
  try {
    await createOperationsReadinessService(bindings).captureMetrics();
  } catch (error) {
    console.error(JSON.stringify({
      description: "生产运维样本采集失败，主收集计划继续执行",
      errorClass: error instanceof Error ? error.name : "UnknownError",
      event: "operations.metrics.capture_failed",
      service: "api",
    }));
  }
  if (bindings.SCHEDULE_ENABLED !== "true") {
    await wake;
    return;
  }
  await createOperationsService(bindings).requestScheduledSync();
  await wake;
}

export async function stageQueueBatch(
  bindings: ApiBindings,
  batch: Pick<MessageBatch<unknown>, "ackAll" | "messages">,
  createQueueInboxService: (bindings: ApiBindings) => QueueInboxService =
    createQueueInboxServiceFromBindings,
  workerFetch: typeof fetch = fetch,
): Promise<void> {
  if (isMigrationFrozen(bindings)) {
    throw new Error("queue processing is paused for migration");
  }

  await createQueueInboxService(bindings).stage(
    batch.messages.map((message) => ({
      body: message.body,
      id: message.id,
      timestampMs: message.timestamp.getTime(),
    })),
  );
  await wakeWorker(bindings, workerFetch);
  batch.ackAll();
}

export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<unknown>, bindings: ApiBindings): Promise<void> {
    return stageQueueBatch(bindings, batch);
  },
  scheduled(
    _controller: ScheduledController,
    bindings: ApiBindings,
    context: ExecutionContext,
  ): void {
    if (isMigrationFrozen(bindings)) return;
    context.waitUntil(publishScheduledCollection(bindings));
  },
};
