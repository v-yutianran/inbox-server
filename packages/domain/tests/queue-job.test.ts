import { describe, expect, it } from "vitest";

import {
  createItemDedupeKey,
  parseQueueJob,
  type QueueJob,
} from "../src/index";

const baseJob = {
  schemaVersion: 1,
  jobId: "8e927d27-cc90-4a61-9fd5-10370b1009de",
  dedupeKey: "collect:zhihu:2026-07-31T12:00:00Z",
  createdAt: "2026-07-31T12:00:00.000Z",
} as const;

describe("parseQueueJob", () => {
  it("解析合法的来源采集任务", () => {
    const job = parseQueueJob({
      ...baseJob,
      kind: "collect-source",
      payload: {
        source: "zhihu",
        triggeredBy: "schedule",
        shadow: true,
      },
    });

    expect(job).toEqual<QueueJob>({
      ...baseJob,
      kind: "collect-source",
      payload: {
        source: "zhihu",
        triggeredBy: "schedule",
        shadow: true,
      },
    });
  });

  it("拒绝未知消息版本", () => {
    expect(() =>
      parseQueueJob({
        ...baseJob,
        schemaVersion: 2,
        kind: "collect-source",
        payload: {
          source: "zhihu",
          triggeredBy: "schedule",
          shadow: true,
        },
      }),
    ).toThrow();
  });

  it("拒绝 kind 与 payload 不匹配的无效状态", () => {
    expect(() =>
      parseQueueJob({
        ...baseJob,
        kind: "dispatch-item",
        payload: {
          itemKind: "link",
          content: "缺少 URL",
        },
      }),
    ).toThrow();
  });
});

describe("createItemDedupeKey", () => {
  it("相同链接忽略标题变化并生成相同幂等键", async () => {
    const first = await createItemDedupeKey({
      itemKind: "link",
      url: "https://example.com/article",
      title: "旧标题",
      tags: [],
    });
    const second = await createItemDedupeKey({
      itemKind: "link",
      url: "https://example.com/article",
      title: "新标题",
      tags: ["更新"],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^dispatch:link:[a-f0-9]{64}$/);
  });

  it("不同文本生成不同幂等键", async () => {
    const first = await createItemDedupeKey({ itemKind: "text", content: "一" });
    const second = await createItemDedupeKey({ itemKind: "text", content: "二" });

    expect(first).not.toBe(second);
  });
});
