import { describe, expect, it, vi } from "vitest";

import type { QueueJob } from "@inbox/domain";
import type { Browser } from "playwright";

import type { Channels } from "../src/channels";
import type { QueueBatch } from "../src/cloudflare-queue-client";
import type { CollectionResult } from "../src/collectors";
import { createJobHandler, queueBatchRequiresBrowser } from "../src/job-handler";
import type { WorkerControlPlane } from "../src/worker-control-plane";

function controlPlane(): WorkerControlPlane {
  return {
    claimEffect: vi.fn().mockResolvedValue({ attempts: 1, state: "claimed" }),
    claimJob: vi.fn(),
    consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }),
    consumeRateLimits: vi.fn().mockResolvedValue({
      allowed: true,
      counts: { "article:daily": 1, "article:window": 1 },
    }),
    finishEffect: vi.fn().mockResolvedValue(undefined),
    finishJob: vi.fn(),
    getCredential: vi.fn(),
    getState: vi.fn(),
    heartbeat: vi.fn(),
    publishJobs: vi.fn().mockResolvedValue(1),
    putLoginSession: vi.fn().mockResolvedValue(undefined),
    putState: vi.fn().mockResolvedValue(undefined),
    recordArticleEvent: vi.fn().mockResolvedValue(undefined),
    rejectInvalidJob: vi.fn(),
  };
}

const collectJob = (shadow: boolean): QueueJob => ({
  createdAt: "2026-08-01T03:00:00.000Z",
  dedupeKey: `collect:github:${shadow}`,
  jobId: shadow
    ? "0f868f15-3b77-4ac8-90d9-f7b59c9721ee"
    : "dd95f857-d334-422f-9f7b-4c4234f10f37",
  kind: "collect-source",
  payload: { shadow, source: "github_stars", triggeredBy: shadow ? "shadow" : "manual" },
  schemaVersion: 1,
});

const collection = (afterCommit = vi.fn()): CollectionResult => ({
  afterCommit,
  items: [
    { itemKind: "link", tags: ["github"], title: "repo", url: "https://github.com/a/b" },
  ],
  meta: { collected: 1 },
  source: "github_stars",
  stateUpdates: [{ key: "baseline:github_stars", value: { knownKeys: ["url"] } }],
});

const channels = {
  article_archive: { enabled: false },
  destinations: {
    cubox: {
      config: { api_url: "https://cubox.example" },
      enabled: true,
      item_kind: "link",
    },
  },
  sources: {},
} as unknown as Channels;

describe("job handler", () => {
  it("仅在批次含浏览器来源或启用归档的文章时要求 browser", () => {
    const batch = (...bodies: unknown[]): QueueBatch => ({
      backlogCount: 0,
      messages: bodies.map((body, index) => ({
        attempts: 1,
        body,
        id: `message-${index}`,
        leaseId: `lease-${index}`,
        timestampMs: index,
      })),
    });

    expect(queueBatchRequiresBrowser(batch(), channels)).toBe(false);
    expect(queueBatchRequiresBrowser(batch({ invalid: true }), channels)).toBe(false);
    expect(queueBatchRequiresBrowser(batch(collectJob(false)), channels)).toBe(false);
    expect(queueBatchRequiresBrowser(batch({
      ...collectJob(false),
      payload: { ...collectJob(false).payload, source: "inoreader" },
    }), channels)).toBe(true);

    const article = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:browser-check",
      jobId: "815aac37-69f9-4af2-838a-8fd22217a462",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/1",
      },
      schemaVersion: 1,
    } as QueueJob;
    expect(queueBatchRequiresBrowser(batch(article), channels)).toBe(false);
    expect(queueBatchRequiresBrowser(batch(article), {
      ...channels,
      article_archive: { enabled: true },
    } as unknown as Channels)).toBe(true);
  });

  it("无 browser 时允许 HTTP 来源，并拒绝需要 browser 的来源", async () => {
    const cp = controlPlane();
    const collect = vi.fn().mockResolvedValue(collection());
    const handle = createJobHandler({
      channels,
      collect,
      controlPlane: cp,
      stagingDir: "/tmp/inbox",
    });

    await expect(handle(collectJob(false))).resolves.toMatchObject({ outcome: "completed" });
    expect(collect).toHaveBeenCalledWith("github_stars", expect.objectContaining({ browser: undefined }));

    const browserJob = {
      ...collectJob(false),
      payload: { ...collectJob(false).payload, source: "inoreader" },
    } as QueueJob;
    await expect(handle(browserJob)).rejects.toThrow("Browser is required for this source");
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("文章归档收到任务关联字段并沿用同一 effect 结算", async () => {
    const cp = controlPlane();
    const archive = vi.fn().mockResolvedValue({ outcome: "ok" });
    const handle = createJobHandler({
      archive,
      browser: {} as Browser,
      channels: {
        article_archive: {
          daily_limit: 500,
          enabled: true,
          rate_window_count: 120,
          rate_window_seconds: 21_600,
        },
        destinations: {},
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      stagingDir: "/tmp/inbox",
    });
    const article = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:correlated",
      jobId: "815aac37-69f9-4af2-838a-8fd22217a462",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/correlated",
      },
      schemaVersion: 1,
    } as QueueJob;

    await expect(handle(article)).resolves.toEqual({
      outcome: "completed",
      summary: { destinations: { article_archive: "done" } },
    });
    expect(archive).toHaveBeenCalledWith(article.payload, {
      dedupeKey: article.dedupeKey,
      jobId: article.jobId,
    });
    expect(cp.finishEffect).toHaveBeenCalledWith(
      "dispatch:article:correlated:article_archive",
      { status: "done" },
    );
  });

  it("归档写入前的确定失败结算 effect failed 并进入 job 失败路径", async () => {
    const cp = controlPlane();
    const handle = createJobHandler({
      archive: vi.fn().mockResolvedValue({
        failurePhase: "before_write",
        outcome: "fail",
        reasonCode: "zhihu_api_rejected",
        status: 503,
      }),
      browser: {} as Browser,
      channels: {
        article_archive: {
          daily_limit: 500,
          enabled: true,
          rate_window_count: 120,
          rate_window_seconds: 21_600,
        },
        destinations: {},
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      stagingDir: "/tmp/inbox",
    });
    const article = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:before-write-failure",
      jobId: "815aac37-69f9-4af2-838a-8fd22217a462",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/before-write-failure",
      },
      schemaVersion: 1,
    } as QueueJob;

    await expect(handle(article)).rejects.toThrow("503");
    expect(cp.finishEffect).toHaveBeenCalledWith(
      "dispatch:article:before-write-failure:article_archive",
      expect.objectContaining({
        errorClass: "retryable",
        errorMessage: expect.stringContaining("503"),
        status: "failed",
      }),
    );
    expect(cp.finishEffect).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "uncertain" }),
    );
  });

  it("归档写入前没有 HTTP 状态时按安全超时原因进入重试策略", async () => {
    const cp = controlPlane();
    const handle = createJobHandler({
      archive: vi.fn().mockResolvedValue({
        failurePhase: "before_write",
        outcome: "fail",
        reasonCode: "article_timeout",
      }),
      browser: {} as Browser,
      channels: {
        article_archive: {
          daily_limit: 500,
          enabled: true,
          rate_window_count: 120,
          rate_window_seconds: 21_600,
        },
        destinations: {},
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      stagingDir: "/tmp/inbox",
    });
    const article = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:before-write-timeout",
      jobId: "2a1725d0-b9f4-477e-8e10-60a55815e5d4",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/before-write-timeout",
      },
      schemaVersion: 1,
    } as QueueJob;

    await expect(handle(article)).rejects.toThrow("article timeout");
    expect(cp.finishEffect).toHaveBeenCalledWith(
      "dispatch:article:before-write-timeout:article_archive",
      expect.objectContaining({
        errorClass: "retryable",
        errorMessage: "article timeout",
        status: "failed",
      }),
    );
  });

  it("归档写入开始后的失败结果继续冻结为 uncertain", async () => {
    const cp = controlPlane();
    const handle = createJobHandler({
      archive: vi.fn().mockResolvedValue({ outcome: "fail" }),
      browser: {} as Browser,
      channels: {
        article_archive: {
          daily_limit: 500,
          enabled: true,
          rate_window_count: 120,
          rate_window_seconds: 21_600,
        },
        destinations: {},
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      stagingDir: "/tmp/inbox",
    });
    const article = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:write-outcome-unknown",
      jobId: "f38536fd-791f-42ee-b6db-979b51a7b2bb",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/write-outcome-unknown",
      },
      schemaVersion: 1,
    } as QueueJob;

    await expect(handle(article)).resolves.toEqual({
      outcome: "uncertain",
      reason: "external_delivery_uncertain",
    });
    expect(cp.finishEffect).toHaveBeenCalledWith(
      "dispatch:article:write-outcome-unknown:article_archive",
      expect.objectContaining({ status: "uncertain" }),
    );
  });

  it("文章限速先于 effect claim 并返回无损延期", async () => {
    const cp = controlPlane();
    vi.mocked(cp.consumeRateLimits).mockResolvedValue({
      allowed: false,
      counts: { "article:daily": 500 },
      retryAt: "2030-01-02T00:00:00.000Z",
    });
    const archive = vi.fn();
    const handle = createJobHandler({
      archive,
      browser: {} as Browser,
      channels: {
        article_archive: {
          daily_limit: 500,
          enabled: true,
          rate_window_count: 120,
          rate_window_seconds: 21_600,
        },
        destinations: {},
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      stagingDir: "/tmp/inbox",
    });
    const article: QueueJob = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:test",
      jobId: "657cb0ad-169b-4cce-92c1-1a6fe47107aa",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/1",
      },
      schemaVersion: 1,
    };

    await expect(handle(article)).resolves.toEqual({
      outcome: "deferred",
      reason: "rate_limit",
      retryAt: "2030-01-02T00:00:00.000Z",
    });
    expect(cp.claimEffect).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("effect busy 形成无损延期而不是抛出失败", async () => {
    const cp = controlPlane();
    vi.mocked(cp.claimEffect).mockResolvedValue({
      retryAt: "2030-01-01T00:10:00.000Z",
      state: "busy",
    });
    const handle = createJobHandler({
      archive: vi.fn(),
      browser: {} as Browser,
      channels: {
        article_archive: {
          daily_limit: 500,
          enabled: true,
          rate_window_count: 120,
          rate_window_seconds: 21_600,
        },
        destinations: {},
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      stagingDir: "/tmp/inbox",
    });
    const article = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:test",
      jobId: "657cb0ad-169b-4cce-92c1-1a6fe47107aa",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/1",
      },
      schemaVersion: 1,
    } as QueueJob;

    await expect(handle(article)).resolves.toEqual({
      outcome: "deferred",
      reason: "effect_busy",
      retryAt: "2030-01-01T00:10:00.000Z",
    });
  });

  it("外部归档结果不确定时冻结任务而不是自动重试", async () => {
    const cp = controlPlane();
    const handle = createJobHandler({
      archive: vi.fn().mockRejectedValue(new Error("connection closed")),
      browser: {} as Browser,
      channels: {
        article_archive: {
          daily_limit: 500,
          enabled: true,
          rate_window_count: 120,
          rate_window_seconds: 21_600,
        },
        destinations: {},
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      stagingDir: "/tmp/inbox",
    });
    const article = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:article:uncertain",
      jobId: "f38536fd-791f-42ee-b6db-979b51a7b2bb",
      kind: "dispatch-item",
      payload: {
        itemKind: "article",
        requestedAt: "2030-01-01T00:00:00.000Z",
        url: "https://example.invalid/article/uncertain",
      },
      schemaVersion: 1,
    } as QueueJob;

    await expect(handle(article)).resolves.toEqual({
      outcome: "uncertain",
      reason: "external_delivery_uncertain",
    });
    expect(cp.finishEffect).toHaveBeenCalledWith(
      "dispatch:article:uncertain:article_archive",
      expect.objectContaining({ status: "uncertain" }),
    );
  });

  it("对象存储下载失败时不会将文件副作用标记完成", async () => {
    const cp = controlPlane();
    const attachmentStore = {
      download: vi.fn().mockRejectedValue(new Error("gcs_object_download_failed")),
      upload: vi.fn(),
    };
    const fetcher = vi.fn();
    const handle = createJobHandler({
      attachmentStore,
      channels: {
        article_archive: { enabled: false },
        destinations: {
          jianguoyun: {
            config: { webdav_pass: "secret", webdav_user: "user@example.com" },
            enabled: true,
            item_kind: "file",
          },
        },
        sources: {},
      } as unknown as Channels,
      controlPlane: cp,
      fetcher,
      stagingDir: "/tmp/inbox",
    });
    const fileJob = {
      createdAt: "2030-01-01T00:00:00.000Z",
      dedupeKey: "dispatch:file:object-key",
      jobId: "8c16b123-b4a8-47c3-a61f-d5d76275af40",
      kind: "dispatch-item",
      payload: {
        itemKind: "file",
        objectKey: "telegram/2fd785d7-47aa-4357-a59f-5039c0434c25",
        remoteName: "a.pdf",
      },
      schemaVersion: 1,
    } as QueueJob;

    await expect(handle(fileJob)).resolves.toEqual({
      outcome: "uncertain",
      reason: "external_delivery_uncertain",
    });
    expect(cp.finishEffect).toHaveBeenCalledWith(
      "dispatch:file:object-key:jianguoyun",
      expect.objectContaining({ status: "uncertain" }),
    );
    expect(cp.finishEffect).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "done" }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shadow 只写对比摘要，不发布、不推进 baseline、不执行来源外部副作用", async () => {
    const cp = controlPlane();
    const afterCommit = vi.fn();
    const handle = createJobHandler({
      browser: {} as Browser,
      channels,
      collect: vi.fn().mockResolvedValue(collection(afterCommit)),
      controlPlane: cp,
      deliver: vi.fn(),
      stagingDir: "/tmp/inbox",
    });

    await expect(handle(collectJob(true))).resolves.toEqual(
      {
        outcome: "completed",
        summary: expect.objectContaining({ collected: 1, shadow: true }),
      },
    );
    expect(cp.publishJobs).not.toHaveBeenCalled();
    expect(cp.putState).toHaveBeenCalledOnce();
    expect(cp.putState).toHaveBeenCalledWith(
      "shadow:github_stars",
      expect.objectContaining({ count: 1, dedupeKeys: expect.any(Array) }),
    );
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it("生产 collect 先发布分发任务，再推进 baseline 与来源提交", async () => {
    const cp = controlPlane();
    const afterCommit = vi.fn();
    const handle = createJobHandler({
      browser: {} as Browser,
      channels,
      collect: vi.fn().mockResolvedValue(collection(afterCommit)),
      controlPlane: cp,
      deliver: vi.fn(),
      stagingDir: "/tmp/inbox",
    });

    await handle(collectJob(false));

    expect(cp.publishJobs).toHaveBeenCalledWith([
      expect.objectContaining({
        dedupeKey: expect.stringMatching(/^dispatch:link:/),
        kind: "dispatch-item",
      }),
    ]);
    expect(cp.putState).toHaveBeenCalledWith("baseline:github_stars", { knownKeys: ["url"] });
    expect(afterCommit).toHaveBeenCalledOnce();
    expect(vi.mocked(cp.publishJobs).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(cp.putState).mock.invocationCallOrder[0]!,
    );
  });

  it("生产 collect 有新内容时只通知一次", async () => {
    const cp = controlPlane();
    const notify = vi.fn().mockResolvedValue(undefined);
    const handle = createJobHandler({
      browser: {} as Browser,
      channels,
      collect: vi.fn().mockResolvedValue(collection()),
      controlPlane: cp,
      deliver: vi.fn(),
      notify,
      stagingDir: "/tmp/inbox",
    });

    await handle(collectJob(false));

    expect(cp.claimEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: "notification",
        effectKey: "collect:github:false:notification",
      }),
    );
    expect(notify).toHaveBeenCalledWith({
      collected: 1,
      published: 1,
      source: "github_stars",
    });
    expect(cp.finishEffect).toHaveBeenCalledWith("collect:github:false:notification", {
      status: "done",
    });
  });

  it("生产 collect 没有新内容时不通知", async () => {
    const cp = controlPlane();
    const notify = vi.fn().mockResolvedValue(undefined);
    const handle = createJobHandler({
      browser: {} as Browser,
      channels,
      collect: vi.fn().mockResolvedValue({
        items: [],
        meta: { collected: 0 },
        source: "github_stars",
        stateUpdates: [],
      } satisfies CollectionResult),
      controlPlane: cp,
      deliver: vi.fn(),
      notify,
      stagingDir: "/tmp/inbox",
    });

    await handle(collectJob(false));

    expect(notify).not.toHaveBeenCalled();
    expect(cp.claimEffect).not.toHaveBeenCalledWith(
      expect.objectContaining({ destination: "notification" }),
    );
  });

  it("effect 已完成时不重复调用外部 destination", async () => {
    const cp = controlPlane();
    vi.mocked(cp.claimEffect).mockResolvedValue({ state: "done" });
    const deliver = vi.fn();
    const handle = createJobHandler({
      browser: {} as Browser,
      channels,
      controlPlane: cp,
      deliver,
      stagingDir: "/tmp/inbox",
    });
    const job: QueueJob = {
      createdAt: "2026-08-01T03:00:00.000Z",
      dedupeKey: "dispatch:link:test",
      jobId: "c2283ab6-2a7d-4de9-a04f-b391578292bf",
      kind: "dispatch-item",
      payload: { itemKind: "link", title: "Example", url: "https://example.com" },
      schemaVersion: 1,
    };

    await expect(handle(job)).resolves.toEqual({
      outcome: "completed",
      summary: { destinations: { cubox: "done" } },
    });
    expect(deliver).not.toHaveBeenCalled();
  });
});
