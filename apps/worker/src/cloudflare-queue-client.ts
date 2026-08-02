import { z } from "zod";

const queueBatchSchema = z.object({
  backlogCount: z.number().int().nonnegative(),
  messages: z.array(
    z.object({
      attempts: z.number().int().positive(),
      body: z.unknown(),
      id: z.string().min(1),
      leaseId: z.string().min(1),
      timestampMs: z.number().int().nonnegative(),
    }),
  ),
});

export interface QueueLease {
  readonly attempts: number;
  readonly body: unknown;
  readonly id: string;
  readonly leaseId: string;
  readonly timestampMs: number;
}

export interface QueueBatch {
  readonly backlogCount: number;
  readonly messages: readonly QueueLease[];
}

export interface QueueSettlement {
  readonly acks: readonly string[];
  readonly retries: readonly {
    readonly delaySeconds?: number;
    readonly leaseId: string;
  }[];
}

export interface CloudflareQueueClient {
  pull(): Promise<QueueBatch>;
  settle(settlement: QueueSettlement): Promise<void>;
}

/** Sealos 只持有最小 service token；Cloudflare Queue 凭据留在 Worker binding 内。 */
export function createControlPlaneQueueClient(
  config: {
    readonly batchSize: number;
    readonly controlPlaneUrl: string;
    readonly serviceToken: string;
    readonly visibilityTimeoutMs: number;
  },
  fetcher: typeof fetch = fetch,
): CloudflareQueueClient {
  const baseUrl = config.controlPlaneUrl.replace(/\/$/, "");
  const headers = {
    authorization: `Bearer ${config.serviceToken}`,
    "content-type": "application/json",
  } as const;

  return {
    async pull() {
      const response = await fetcher(`${baseUrl}/internal/queue/pull`, {
        body: JSON.stringify({
          batchSize: config.batchSize,
          visibilityTimeoutMs: config.visibilityTimeoutMs,
        }),
        headers,
        method: "POST",
      });
      if (!response.ok) throw new Error(`queue pull failed: ${response.status}`);
      const parsed = queueBatchSchema.safeParse(await readJson(response));
      if (!parsed.success) throw new Error("queue pull response is invalid");
      return parsed.data;
    },

    async settle(settlement) {
      assertDistinctLeases(settlement);
      if (settlement.acks.length === 0 && settlement.retries.length === 0) return;
      const response = await fetcher(`${baseUrl}/internal/queue/settle`, {
        body: JSON.stringify(settlement),
        headers,
        method: "POST",
      });
      if (!response.ok) throw new Error(`queue settlement failed: ${response.status}`);
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("queue pull response is invalid");
  }
}

function assertDistinctLeases(settlement: QueueSettlement): void {
  const acknowledged = new Set(settlement.acks);
  for (const retry of settlement.retries) {
    if (acknowledged.has(retry.leaseId)) {
      throw new Error("lease cannot be acknowledged and retried");
    }
  }
}
