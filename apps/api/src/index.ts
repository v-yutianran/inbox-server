import { createApp } from "./app.js";
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

export async function publishScheduledCollection(
  bindings: ApiBindings,
  createOperationsService: (bindings: ApiBindings) => OperationsService =
    createOperationsServiceFromBindings,
  createOperationsReadinessService: (
    bindings: ApiBindings,
  ) => OperationsReadinessService = createOperationsReadinessServiceFromBindings,
): Promise<void> {
  await createOperationsReadinessService(bindings).captureMetrics();
  if (bindings.SCHEDULE_ENABLED !== "true") return;
  await createOperationsService(bindings).requestScheduledSync();
}

export async function stageQueueBatch(
  bindings: ApiBindings,
  batch: Pick<MessageBatch<unknown>, "ackAll" | "messages">,
  createQueueInboxService: (bindings: ApiBindings) => QueueInboxService =
    createQueueInboxServiceFromBindings,
): Promise<void> {
  await createQueueInboxService(bindings).stage(
    batch.messages.map((message) => ({
      body: message.body,
      id: message.id,
      timestampMs: message.timestamp.getTime(),
    })),
  );
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
    context.waitUntil(publishScheduledCollection(bindings));
  },
};
