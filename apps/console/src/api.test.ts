import { describe, expect, it } from "vitest";

import { createApiUrl } from "./api";

describe("Cloudflare API URL", () => {
  it("本地开发未配置 API 基址时保持同源路径", () => {
    expect(createApiUrl("/healthz", "")).toBe("/healthz");
  });

  it("Pages 构建使用独立 Workers API 基址", () => {
    expect(
      createApiUrl(
        "/api/operations/overview",
        "https://inbox-server-api.example.workers.dev/",
      ),
    ).toBe("https://inbox-server-api.example.workers.dev/api/operations/overview");
  });

  it("拒绝非 HTTPS 的远端 API 基址", () => {
    expect(() => createApiUrl("/healthz", "http://example.com")).toThrow(
      "Cloudflare API 基址必须使用 HTTPS",
    );
  });
});
