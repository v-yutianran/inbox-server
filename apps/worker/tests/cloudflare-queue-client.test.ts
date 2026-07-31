import { describe, expect, it, vi } from "vitest";

import { createCloudflareQueueClient } from "../src/cloudflare-queue-client.js";

const config = {
  accountId: "account-id",
  apiToken: "secret-token",
  batchSize: 2,
  queueId: "queue-id",
  visibilityTimeoutMs: 60_000,
} as const;

describe("Cloudflare Queues pull consumer", () => {
  it("按固定批量和 lease 超时拉取消息", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        errors: [],
        result: {
          message_backlog_count: 3,
          messages: [
            {
              attempts: 1,
              body: { kind: "collect-source" },
              id: "message-1",
              lease_id: "lease-1",
              timestamp_ms: 1_754_000_000_000,
            },
          ],
        },
        success: true,
      }),
    );
    const client = createCloudflareQueueClient(config, fetcher);

    const batch = await client.pull();

    expect(batch).toEqual({
      backlogCount: 3,
      messages: [
        {
          attempts: 1,
          body: { kind: "collect-source" },
          id: "message-1",
          leaseId: "lease-1",
          timestampMs: 1_754_000_000_000,
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/queues/queue-id/messages/pull",
      {
        body: JSON.stringify({ batch_size: 2, visibility_timeout_ms: 60_000 }),
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("一次提交 ack 与延迟 retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ errors: [], result: {}, success: true }),
    );
    const client = createCloudflareQueueClient(config, fetcher);

    await client.settle({
      acks: ["lease-1"],
      retries: [{ delaySeconds: 30, leaseId: "lease-2" }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/queues/queue-id/messages/ack",
      {
        body: JSON.stringify({
          acks: [{ lease_id: "lease-1" }],
          retries: [{ delay_seconds: 30, lease_id: "lease-2" }],
        }),
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  });

  it("拒绝同时 ack 和 retry 同一 lease", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createCloudflareQueueClient(config, fetcher);

    await expect(
      client.settle({ acks: ["lease-1"], retries: [{ leaseId: "lease-1" }] }),
    ).rejects.toThrow("lease cannot be acknowledged and retried");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("API 错误不泄露 token 或完整响应", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          errors: [{ code: 10_000, message: "token secret-token rejected" }],
          result: null,
          success: false,
        },
        { status: 403 },
      ),
    );
    const client = createCloudflareQueueClient(config, fetcher);

    const request = client.pull();

    await expect(request).rejects.toThrow("Cloudflare Queues request failed: 403");
    await expect(request).rejects.not.toThrow("secret-token");
  });
});
