import { z } from "zod";

const pullResponseSchema = z.object({
  result: z.object({
    message_backlog_count: z.number().int().nonnegative(),
    messages: z.array(
      z.object({
        attempts: z.number().int().nonnegative(),
        body: z.unknown(),
        id: z.string().min(1),
        lease_id: z.string().min(1),
        timestamp_ms: z.number().int().nonnegative(),
      }),
    ),
  }),
  success: z.literal(true),
});

const successResponseSchema = z.object({ success: z.literal(true) });

export interface CloudflareQueueConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly batchSize: number;
  readonly queueId: string;
  readonly visibilityTimeoutMs: number;
}

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

/** 将 Cloudflare HTTP pull 协议限制在基础设施边界，避免 token 进入业务错误。 */
export function createCloudflareQueueClient(
  config: CloudflareQueueConfig,
  fetcher: typeof fetch = fetch,
): CloudflareQueueClient {
  const queueUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/queues/${encodeURIComponent(config.queueId)}/messages`;
  const headers = {
    authorization: `Bearer ${config.apiToken}`,
    "content-type": "application/json",
  } as const;

  return {
    async pull(): Promise<QueueBatch> {
      const payload = await requestJson(fetcher, `${queueUrl}/pull`, {
        body: JSON.stringify({
          batch_size: config.batchSize,
          visibility_timeout_ms: config.visibilityTimeoutMs,
        }),
        headers,
        method: "POST",
      });
      const parsed = pullResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Cloudflare Queues response is invalid");
      return {
        backlogCount: parsed.data.result.message_backlog_count,
        messages: parsed.data.result.messages.map((message) => ({
          attempts: message.attempts,
          body: message.body,
          id: message.id,
          leaseId: message.lease_id,
          timestampMs: message.timestamp_ms,
        })),
      };
    },

    async settle(settlement: QueueSettlement): Promise<void> {
      assertDistinctLeases(settlement);
      if (settlement.acks.length === 0 && settlement.retries.length === 0) return;
      const payload = await requestJson(fetcher, `${queueUrl}/ack`, {
        body: JSON.stringify({
          acks: settlement.acks.map((leaseId) => ({ lease_id: leaseId })),
          retries: settlement.retries.map((retry) => ({
            ...(retry.delaySeconds === undefined
              ? {}
              : { delay_seconds: retry.delaySeconds }),
            lease_id: retry.leaseId,
          })),
        }),
        headers,
        method: "POST",
      });
      if (!successResponseSchema.safeParse(payload).success) {
        throw new Error("Cloudflare Queues response is invalid");
      }
    },
  };
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, init);
  if (!response.ok) {
    throw new Error(`Cloudflare Queues request failed: ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Cloudflare Queues response is invalid");
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
