import { describe, expect, it, vi } from "vitest";

import { classifyJobFailure, type QueueJob } from "@inbox/domain";
import type { Browser } from "playwright";

import { collectBrowserSource } from "../src/browser-collectors";
import type { Channels } from "../src/channels";
import { createJobHandler } from "../src/job-handler";
import type { WorkerControlPlane } from "../src/worker-control-plane";

type ContentState = "delayed" | "login" | "never";

function controlPlane(): WorkerControlPlane {
  return {
    claimEffect: vi.fn().mockResolvedValue({ attempts: 1, state: "claimed" }),
    claimJob: vi.fn(),
    consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }),
    consumeRateLimits: vi.fn().mockResolvedValue({ allowed: true, counts: {} }),
    finishEffect: vi.fn().mockResolvedValue(undefined),
    finishJob: vi.fn(),
    getCredential: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    getState: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn(),
    publishJobs: vi.fn().mockResolvedValue(0),
    putLoginSession: vi.fn().mockResolvedValue(undefined),
    putState: vi.fn().mockResolvedValue(undefined),
    recordArticleEvent: vi.fn().mockResolvedValue(undefined),
    rejectInvalidJob: vi.fn(),
  };
}

const channels = {
  article_archive: { enabled: false },
  destinations: {},
  sources: {
    inoreader: {
      config: { credential_name: "inoreader_creds" },
      enabled: true,
      kind: "browser",
    },
  },
} as unknown as Channels;

function browserHarness(contentState: ContentState) {
  let contentReady = false;
  let currentUrl = "https://www.inoreader.com/starred";
  const waitForSelector = vi.fn().mockImplementation(async () => {
    if (contentState === "delayed") {
      contentReady = true;
      return undefined;
    }
    if (contentState === "login") currentUrl = "https://www.inoreader.com/login";
    throw new Error("Timeout 60000ms exceeded");
  });
  const page = {
    close: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async () => contentReady
      ? [{ key: "article_101", title: "Delayed article", url: "https://example.com/article" }]
      : []),
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => currentUrl),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForSelector,
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
  } as unknown as Browser;
  return { browser, context, page };
}

const collectJob: QueueJob = {
  createdAt: "2026-08-05T08:00:00.000Z",
  dedupeKey: "collect:inoreader:readiness",
  jobId: "413c7d40-2ea0-4e10-acad-bb2ca02ed163",
  kind: "collect-source",
  payload: { shadow: false, source: "inoreader", triggeredBy: "manual" },
  schemaVersion: 1,
};

describe("Inoreader SPA 内容就绪", () => {
  it("document.body 先出现时等待延迟渲染的 article 再采集", async () => {
    const cp = controlPlane();
    const { browser, page } = browserHarness("delayed");

    const result = await collectBrowserSource("inoreader", {
      browser,
      channels,
      controlPlane: cp,
      stagingDir: "/tmp/inbox",
    });

    expect(result.items).toEqual([
      {
        itemKind: "link",
        tags: [],
        title: "Delayed article",
        url: "https://example.com/article",
      },
    ]);
    expect(page.waitForSelector).toHaveBeenCalledWith(
      expect.stringContaining("article"),
      { timeout: 60_000 },
    );
  });

  it.each([
    ["never", "inoreader content not ready: timeout"],
    ["login", "inoreader login expired"],
  ] as const)("%s 时失败且不推进任何下游副作用", async (contentState, errorMessage) => {
    const cp = controlPlane();
    const notify = vi.fn().mockResolvedValue(undefined);
    const { browser, page } = browserHarness(contentState);
    const handle = createJobHandler({
      browser,
      channels,
      controlPlane: cp,
      notify,
      stagingDir: "/tmp/inbox",
    });

    await expect(handle(collectJob)).rejects.toThrow(errorMessage);

    expect(page.close).toHaveBeenCalledOnce();
    expect(cp.publishJobs).not.toHaveBeenCalled();
    expect(cp.putState).not.toHaveBeenCalled();
    expect(cp.putLoginSession).not.toHaveBeenCalled();
    expect(cp.claimEffect).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("内容就绪超时沿用既有重试分类", () => {
    expect(classifyJobFailure(new Error("inoreader content not ready: timeout"))).toEqual({
      errorClass: "retryable",
      safeMessage: "inoreader content not ready: timeout",
    });
  });
});
