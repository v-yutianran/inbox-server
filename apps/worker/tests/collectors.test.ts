import { describe, expect, it, vi } from "vitest";

import type { Browser } from "playwright";

import type { Channels } from "../src/channels";
import { collectSource } from "../src/collectors";
import type { WorkerControlPlane } from "../src/worker-control-plane";

function controlPlane(state: unknown): WorkerControlPlane {
  return {
    claimEffect: vi.fn(),
    claimJob: vi.fn(),
    consumeRateLimit: vi.fn(),
    finishEffect: vi.fn(),
    finishJob: vi.fn(),
    getCredential: vi.fn(),
    getState: vi.fn().mockResolvedValue(state),
    heartbeat: vi.fn(),
    publishJobs: vi.fn(),
    putLoginSession: vi.fn(),
    putState: vi.fn(),
    recordArticleEvent: vi.fn(),
    rejectInvalidJob: vi.fn(),
  };
}

describe("collectors", () => {
  it("GitHub Stars 用 D1 baseline 过滤，collector 本身不发布或修改状态", async () => {
    const cp = controlPlane({ knownKeys: ["https://github.com/known/repo"] });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { full_name: "new/repo", html_url: "https://github.com/new/repo" },
          { full_name: "known/repo", html_url: "https://github.com/known/repo" },
        ]),
        { headers: { "Content-Type": "application/json" }, status: 200 },
      ),
    );
    const channels = {
      sources: {
        github_stars: { config: { token: "secret" }, enabled: true, kind: "api" },
      },
    } as unknown as Channels;

    const result = await collectSource("github_stars", {
      browser: {} as Browser,
      channels,
      controlPlane: cp,
      fetcher,
      stagingDir: "/tmp/inbox-test",
    });

    expect(result.items).toEqual([
      {
        itemKind: "link",
        tags: ["github"],
        title: "new/repo",
        url: "https://github.com/new/repo",
      },
    ]);
    expect(result.stateUpdates).toEqual([
      {
        key: "baseline:github_stars",
        value: {
          knownKeys: ["https://github.com/known/repo", "https://github.com/new/repo"],
        },
      },
    ]);
    expect(cp.publishJobs).not.toHaveBeenCalled();
    expect(cp.putState).not.toHaveBeenCalled();
  });
});
