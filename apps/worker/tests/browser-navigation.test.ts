import { describe, expect, it, vi } from "vitest";

import {
  browserNavigationOptions,
  runBrowserOperationWithTimeout,
  scrollDocumentToEnd,
  scrollExtract,
  waitForDocumentBody,
} from "../src/browser-collectors";

const browserSources = [
  "zhihu",
  "bilibili",
  "bilibili_toview",
  "inoreader",
  "youtube",
  "x_bookmarks",
  "x_likes",
] as const;

describe("browser collector navigation", () => {
  it.each(browserSources)("%s 仅等待主文档响应，避免长连接阻塞采集", (source) => {
    expect(browserNavigationOptions(source)).toEqual({
      timeout: 60_000,
      waitUntil: "commit",
    });
  });

  it("DOM 型来源在读取页面前等待 document.body", async () => {
    const waitForFunction = vi.fn().mockResolvedValue(undefined);

    await waitForDocumentBody({ waitForFunction } as never);

    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { timeout: 60_000 },
    );
  });

  it("browser source 总时限到期时关闭独立 context 并返回可重试超时", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    try {
      const operation = runBrowserOperationWithTimeout(
        () => new Promise<never>(() => undefined),
        onTimeout,
        100,
      );
      const rejection = expect(operation).rejects.toThrow("browser source timeout");
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(onTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("遇到已知基线边界后不再继续滚动 YouTube 列表", async () => {
    const evaluate = vi.fn().mockResolvedValue([{ key: "new" }, { key: "known" }]);
    const waitForFunction = vi.fn();
    const waitForTimeout = vi.fn();

    const items = await scrollExtract(
      { evaluate, waitForFunction, waitForTimeout } as never,
      () => [],
      (input) => input as readonly { readonly key: string }[],
      (current) => current.some(({ key }) => key === "known"),
    );

    expect(items).toEqual([{ key: "new" }, { key: "known" }]);
    expect(waitForFunction).not.toHaveBeenCalled();
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it("滚动时原子等待页面切换后的 document.body", async () => {
    let body: { scrollHeight: number } | null = null;
    const scrollTo = vi.fn();
    vi.stubGlobal("document", {
      get body() {
        return body;
      },
    });
    vi.stubGlobal("window", { scrollTo });
    const waitForFunction = vi.fn().mockImplementation(async (predicate: () => boolean) => {
      expect(predicate()).toBe(false);
      body = { scrollHeight: 2_048 };
      expect(predicate()).toBe(true);
    });

    try {
      await scrollDocumentToEnd({ waitForFunction } as never);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { timeout: 60_000 },
    );
    expect(scrollTo).toHaveBeenCalledWith(0, 2_048);
  });
});
