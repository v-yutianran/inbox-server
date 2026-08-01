import { describe, expect, it, vi } from "vitest";

import type { QueueJob } from "@inbox/domain";
import type { Browser } from "playwright";

import type { Channels } from "../src/channels";
import type { CollectionResult } from "../src/collectors";
import { createJobHandler } from "../src/job-handler";
import type { WorkerControlPlane } from "../src/worker-control-plane";

function controlPlane(): WorkerControlPlane {
  return {
    claimEffect: vi.fn().mockResolvedValue({ attempts: 1, state: "claimed" }),
    claimJob: vi.fn(),
    consumeRateLimit: vi.fn().mockResolvedValue({ allowed: true, count: 1 }),
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
      expect.objectContaining({ collected: 1, shadow: true }),
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

    await expect(handle(job)).resolves.toEqual({ destinations: { cubox: "done" } });
    expect(deliver).not.toHaveBeenCalled();
  });
});
