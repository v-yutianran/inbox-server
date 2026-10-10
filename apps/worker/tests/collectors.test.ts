import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    consumeRateLimits: vi.fn(),
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
  it.each([204, 500])("滴答已保存链接顺序清理，404 继续而 %i 决定是否停止", async (deleteStatus) => {
    const tasks = [1, 2, 3].map((id) => ({
      id: String(id), projectId: "inbox", title: `https://example.com/${id}`,
    }));
    const cp = controlPlane({ savedTitles: tasks.map(({ title }) => title) });
    const deleted: string[] = [];
    let active = 0;
    let maxActive = 0;
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") {
        return new Response(JSON.stringify({ tasks: [...tasks, { title: "普通待办" }] }));
      }
      const id = String(input).split("/").at(-1)!;
      deleted.push(id);
      maxActive = Math.max(maxActive, ++active);
      await Promise.resolve();
      active -= 1;
      return new Response(null, { status: id === "1" ? 404 : deleteStatus });
    }) as unknown as typeof fetch;
    const result = await collectSource("dida", {
      browser: {} as Browser,
      channels: {
        sources: { dida: { config: { access_token: "token" }, enabled: true, kind: "api" } },
      } as unknown as Channels,
      controlPlane: cp, fetcher, stagingDir: "/tmp/inbox-test",
    });

    expect(result.items).toEqual([]);
    expect(deleted).toEqual([]);
    expect(cp.publishJobs).not.toHaveBeenCalled();
    expect(cp.putState).not.toHaveBeenCalled();
    if (deleteStatus === 500) {
      await expect(result.afterCommit!()).rejects.toThrow("Dida delete request failed: 500");
      expect(deleted).toEqual(["1", "2"]);
    } else {
      await result.afterCommit!();
      expect(deleted).toEqual(["1", "2", "3"]);
    }
    expect(maxActive).toBe(1);
  });

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

  it("Telegram 使用对象存储时只把 object key 放进 dispatch item", async () => {
    const attachmentStore = {
      download: vi.fn(),
      upload: vi.fn().mockResolvedValue(undefined),
    };
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("getUpdates")) {
        return new Response(JSON.stringify({
          result: [{ update_id: 10, message: { document: { file_id: "f1", file_name: "a.pdf" } } }],
        }), { status: 200 });
      }
      if (url.includes("getFile")) {
        return new Response(JSON.stringify({ result: { file_path: "documents/a.pdf" } }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const channels = {
      sources: { telegram: { config: { bot_token: "token" }, enabled: true, kind: "api" } },
    } as unknown as Channels;
    const result = await collectSource("telegram", {
      attachmentStore,
      browser: {} as Browser,
      channels,
      controlPlane: controlPlane(null),
      fetcher,
      stagingDir: "/tmp/inbox-test",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ itemKind: "file", remoteName: "a.pdf" });
    expect(result.items[0]).toHaveProperty("objectKey", expect.stringMatching(/^telegram\/[0-9a-f-]{36}$/));
    expect(result.items[0]).not.toHaveProperty("localPath");
    expect(attachmentStore.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^telegram\/[0-9a-f-]{36}$/),
      new Uint8Array([1, 2, 3]),
    );
  });

  it("未配置对象存储时保留旧 localPath 附件行为", async () => {
    const stagingDir = await mkdtemp(join(tmpdir(), "inbox-telegram-local-"));
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("getUpdates")) {
        return new Response(JSON.stringify({
          result: [{ update_id: 10, message: { document: { file_id: "f1", file_name: "a.pdf" } } }],
        }), { status: 200 });
      }
      if (url.includes("getFile")) {
        return new Response(JSON.stringify({ result: { file_path: "documents/a.pdf" } }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const channels = {
      sources: { telegram: { config: { bot_token: "token" }, enabled: true, kind: "api" } },
    } as unknown as Channels;

    try {
      const result = await collectSource("telegram", {
        browser: {} as Browser,
        channels,
        controlPlane: controlPlane(null),
        fetcher,
        stagingDir,
      });
      const item = result.items[0];
      expect(item).toMatchObject({ itemKind: "file", remoteName: "a.pdf" });
      expect(item).toHaveProperty("localPath");
      expect(await readFile((item as { localPath: string }).localPath)).toEqual(
        Buffer.from([1, 2, 3]),
      );
    } finally {
      await rm(stagingDir, { force: true, recursive: true });
    }
  });
});
