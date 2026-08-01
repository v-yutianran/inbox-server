import { createApp } from "./app.js";
import type { ApiBindings } from "./auth.js";
import {
  createOperationsServiceFromBindings,
  type OperationsService,
} from "./operations.js";

const app = createApp();

export async function publishScheduledCollection(
  bindings: ApiBindings,
  createOperationsService: (bindings: ApiBindings) => OperationsService =
    createOperationsServiceFromBindings,
): Promise<void> {
  if (bindings.SCHEDULE_ENABLED !== "true") return;
  await createOperationsService(bindings).requestScheduledSync();
}

export default {
  fetch: app.fetch,
  scheduled(
    _controller: ScheduledController,
    bindings: ApiBindings,
    context: ExecutionContext,
  ): void {
    context.waitUntil(publishScheduledCollection(bindings));
  },
};
