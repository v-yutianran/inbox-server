import { describe, expect, it } from "vitest";

import { browserLaunchOptions } from "../src/browser";

describe("headed browser", () => {
  it("直连时保留默认 Chromium 传输协议", () => {
    expect(browserLaunchOptions()).toEqual({ headless: false });
  });

  it("经 WARP CONNECT 代理时使用已验证的 HTTP/1.1 通道", () => {
    expect(browserLaunchOptions("http://127.0.0.1:40001")).toEqual({
      args: ["--disable-http2", "--disable-quic"],
      headless: false,
      proxy: { server: "http://127.0.0.1:40001" },
    });
  });
});
