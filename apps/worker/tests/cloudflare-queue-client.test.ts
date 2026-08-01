import { describe, expect, it, vi } from "vitest";

import { createControlPlaneQueueClient } from "../src/cloudflare-queue-client.js";

const config = {
  batchSize: 2,
  controlPlaneUrl: "https://api.example.com/",
  serviceToken: "service-secret",
  visibilityTimeoutMs: 60_000,
} as const;

describe("D1 queue inbox client", () => {
  it("用服务令牌按固定批量和 lease 超时领取消息", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
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
      }),
    );
    const client = createControlPlaneQueueClient(config, fetcher);

    await expect(client.pull()).resolves.toEqual({
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
    expect(fetcher).toHaveBeenCalledWith("https://api.example.com/internal/queue/pull", {
      body: JSON.stringify({ batchSize: 2, visibilityTimeoutMs: 60_000 }),
      headers: {
        authorization: "Bearer service-secret",
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("一次提交 ack 与延迟 retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createControlPlaneQueueClient(config, fetcher);
    const settlement = {
      acks: ["lease-1"],
      retries: [{ delaySeconds: 30, leaseId: "lease-2" }],
    } as const;

    await client.settle(settlement);

    expect(fetcher).toHaveBeenCalledWith("https://api.example.com/internal/queue/settle", {
      body: JSON.stringify(settlement),
      headers: {
        authorization: "Bearer service-secret",
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("拒绝同时 ack 和 retry 同一 lease", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createControlPlaneQueueClient(config, fetcher);

    await expect(
      client.settle({ acks: ["lease-1"], retries: [{ leaseId: "lease-1" }] }),
    ).rejects.toThrow("lease cannot be acknowledged and retried");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("API 错误不泄露 service token 或响应正文", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ detail: "service-secret rejected" }, { status: 403 }),
    );
    const client = createControlPlaneQueueClient(config, fetcher);
    const request = client.pull();

    await expect(request).rejects.toThrow("queue pull failed: 403");
    await expect(request).rejects.not.toThrow("service-secret");
  });
});
