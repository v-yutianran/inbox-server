import { chromium, type Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { browserLaunchOptions, connectCloudflareBrowser, runBrowserBatch } from "../src/browser";

describe("headed browser", () => {
  it("直连时保留默认 Chromium 传输协议", () => {
    expect(browserLaunchOptions(undefined, 900_000)).toEqual({
      headless: false,
      timeout: 900_000,
    });
  });

  it("经 WARP CONNECT 代理时使用已验证的 HTTP/1.1 通道", () => {
    expect(browserLaunchOptions("http://127.0.0.1:40001", 600_000)).toEqual({
      args: ["--disable-http2", "--disable-quic"],
      headless: false,
      proxy: { server: "http://127.0.0.1:40001" },
      timeout: 600_000,
    });
  });
});

describe("Cloudflare Browser Run connection", () => {
  it("用独立 bearer header 通过 CDP 连接并限制握手时间", async () => {
    const browser = { close: vi.fn() } as unknown as Browser;
    const connect = vi.spyOn(chromium, "connectOverCDP").mockResolvedValue(browser);

    await expect(connectCloudflareBrowser("account-id", "browser-token", 12_000))
      .resolves.toBe(browser);
    expect(connect).toHaveBeenCalledWith(
      "wss://api.cloudflare.com/client/v4/accounts/account-id/browser-rendering/devtools/browser?keep_alive=60000",
      { headers: { Authorization: "Bearer browser-token" }, timeout: 12_000 },
    );
    connect.mockRestore();
  });

  it("连接失败时不向调用方暴露 CDP 错误中的凭据", async () => {
    const connect = vi.spyOn(chromium, "connectOverCDP")
      .mockRejectedValue(new Error("Authorization: Bearer browser-token"));

    let message = "";
    try {
      await connectCloudflareBrowser("account-id", "browser-token", 12_000);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Cloudflare Browser Run connection failed");
    expect(message).not.toContain("browser-token");
    connect.mockRestore();
  });

  it("无浏览器任务时不连接，并在批次处理完成后关闭连接", async () => {
    const send = vi.fn().mockResolvedValue({});
    const browser = {
      newBrowserCDPSession: vi.fn().mockResolvedValue({ send }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    const connect = vi.fn().mockResolvedValue(browser);
    const processBatch = vi.fn().mockResolvedValue("settled");

    await expect(runBrowserBatch(false, connect, processBatch)).resolves.toBe("settled");
    expect(connect).not.toHaveBeenCalled();
    expect(processBatch).toHaveBeenCalledWith(undefined);
    expect(browser.close).not.toHaveBeenCalled();

    await expect(runBrowserBatch(true, connect, processBatch)).resolves.toBe("settled");
    expect(processBatch).toHaveBeenLastCalledWith(browser);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("Browser.close");
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(browser.close).mock.invocationCallOrder[0]!);
  });

  it("批次处理失败仍关闭已建立的 browser", async () => {
    const send = vi.fn().mockResolvedValue({});
    const browser = {
      newBrowserCDPSession: vi.fn().mockResolvedValue({ send }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    const processBatch = vi.fn().mockRejectedValue(new Error("batch failed"));

    await expect(runBrowserBatch(true, async () => browser, processBatch))
      .rejects.toThrow("batch failed");
    expect(browser.close).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("Browser.close");
  });

  it("服务端关闭失败仍释放客户端连接，并隐藏清理错误中的凭据", async () => {
    const browser = {
      newBrowserCDPSession: vi.fn().mockRejectedValue(new Error("Bearer browser-token")),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser;
    await expect(runBrowserBatch(true, async () => browser, async () => "settled"))
      .rejects.toThrow("Cloudflare Browser Run cleanup failed");
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
