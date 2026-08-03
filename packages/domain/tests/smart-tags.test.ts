import { describe, expect, it } from "vitest";

import {
  buildSmartTagPrompt,
  formatFlomoContent,
  parseSmartTags,
} from "../src/smart-tags";

describe("smart tags", () => {
  it("构建 prompt 时将正文截断到 1500 字符", () => {
    const prompt = buildSmartTagPrompt("文".repeat(1_600));
    expect(prompt.endsWith("文".repeat(1_500))).toBe(true);
    expect(prompt).not.toContain("文".repeat(1_501));
  });

  it("清洗并限制为三个至少两个字的标签", () => {
    expect(parseSmartTags("#读书 笔记，时间管理\nA、效率工具,第四标签")).toEqual([
      "读书笔记",
      "时间管理",
      "效率工具",
    ]);
  });

  it("按 Flomo 语义把标签前置到原文", () => {
    expect(formatFlomoContent("正文", ["效率", "阅读"])).toBe("#效率 #阅读 正文");
    expect(formatFlomoContent("正文", [])).toBe("正文");
  });
});
