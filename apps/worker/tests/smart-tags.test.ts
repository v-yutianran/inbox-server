import { describe, expect, it, vi } from "vitest";

import { generateSmartTags } from "../src/smart-tags";

describe("GLM smart tags", () => {
  it("按兼容契约请求 GLM 并解析标签", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "读书笔记,时间管理,效率工具" } }] }),
        { status: 200 },
      ),
    );

    await expect(
      generateSmartTags({ apiKey: "secret", content: "正文", fetcher }),
    ).resolves.toEqual(["读书笔记", "时间管理", "效率工具"]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        method: "POST",
      }),
    );
  });

  it("GLM 失败时返回空标签，不阻塞投递", async () => {
    const warn = vi.fn();
    await expect(
      generateSmartTags({
        apiKey: "secret",
        content: "正文",
        fetcher: vi.fn().mockRejectedValue(new Error("network failed")),
        warn,
      }),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith("smart_tags_failed", "network failed");
  });
});
