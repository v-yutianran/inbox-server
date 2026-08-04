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

  it("Inoreader 可见数量不变但 key 变化时累积全部唯一条目", async () => {
    const first = Array.from({ length: 30 }, (_, index) => ({ key: `first-${index}` }));
    const second = Array.from({ length: 30 }, (_, index) => ({ key: `second-${index}` }));
    const evaluate = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValue(second);
    const waitForFunction = vi.fn().mockResolvedValue(undefined);
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);

    const items = await scrollExtract(
      { evaluate, waitForFunction, waitForTimeout } as never,
      () => [],
      (input) => input as readonly { readonly key: string }[],
      undefined,
      ({ key }) => key,
    );

    expect(items).toEqual([...first, ...second]);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(waitForFunction).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledTimes(2);
  });

  it("Inoreader 相邻窗口重叠时按 key 去重并保留首次发现顺序", async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce([{ key: "a" }, { key: "b" }, { key: "c" }])
      .mockResolvedValueOnce([{ key: "c" }, { key: "d" }, { key: "e" }])
      .mockResolvedValue([{ key: "c" }, { key: "d" }, { key: "e" }]);

    const items = await scrollExtract(
      {
        evaluate,
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
      } as never,
      () => [],
      (input) => input as readonly { readonly key: string }[],
      undefined,
      ({ key }) => key,
    );

    expect(items).toEqual([
      { key: "a" },
      { key: "b" },
      { key: "c" },
      { key: "d" },
      { key: "e" },
    ]);
  });

  it("Inoreader 当前轮没有新 key 时停止滚动", async () => {
    const evaluate = vi.fn().mockResolvedValue([{ key: "a" }, { key: "b" }]);
    const waitForFunction = vi.fn().mockResolvedValue(undefined);
    const waitForTimeout = vi.fn().mockResolvedValue(undefined);

    const items = await scrollExtract(
      { evaluate, waitForFunction, waitForTimeout } as never,
      () => [],
      (input) => input as readonly { readonly key: string }[],
      undefined,
      ({ key }) => key,
    );

    expect(items).toEqual([{ key: "a" }, { key: "b" }]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(waitForFunction).toHaveBeenCalledOnce();
    expect(waitForTimeout).toHaveBeenCalledOnce();
  });

  it("Inoreader 持续发现新 key 时最多读取 20 轮", async () => {
    let round = 0;
    const evaluate = vi.fn().mockImplementation(async () => [{ key: `key-${round++}` }]);

    const items = await scrollExtract(
      {
        evaluate,
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
      } as never,
      () => [],
      (input) => input as readonly { readonly key: string }[],
      undefined,
      ({ key }) => key,
    );

    expect(items).toHaveLength(20);
    expect(evaluate).toHaveBeenCalledTimes(20);
  });

  it("未提供稳定 key 时保持按可见数量停止的既有行为", async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce([{ key: "first-a" }, { key: "first-b" }])
      .mockResolvedValue([{ key: "second-a" }, { key: "second-b" }]);

    const items = await scrollExtract(
      {
        evaluate,
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
      } as never,
      () => [],
      (input) => input as readonly { readonly key: string }[],
    );

    expect(items).toEqual([{ key: "first-a" }, { key: "first-b" }]);
    expect(evaluate).toHaveBeenCalledTimes(2);
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
