import { describe, expect, it } from "vitest";

import {
  parseBilibiliFavorites,
  parseBilibiliToview,
  parseDidaTasks,
  parseGithubStars,
  parseInoreaderItems,
  parseTelegramUpdates,
  parseXTweets,
  parseYoutubeItems,
  parseZhihuCollection,
} from "../src/collector-parsers";

describe("collector parsers", () => {
  it("Telegram 保持文件优先、Markdown 链接与 offset 语义", () => {
    const parsed = parseTelegramUpdates(
      {
        result: [
          { update_id: 8, message: { text: "[标题](https://example.com/a)" } },
          { update_id: 9, message: { text: "纯文本" } },
          { update_id: 10, message: { document: { file_id: "f1", file_name: "a.pdf" }, text: "忽略" } },
        ],
      },
      7,
    );

    expect(parsed.offset).toBe(10);
    expect(parsed.items).toEqual([
      { itemKind: "link", tags: [], title: "标题", url: "https://example.com/a" },
      { content: "纯文本", itemKind: "text" },
    ]);
    expect(parsed.files).toEqual([{ fileId: "f1", remoteName: "a.pdf" }]);
  });

  it("Dida 只选择含 URL 且未保存的任务，同时保留待删除标识", () => {
    const parsed = parseDidaTasks(
      [
        { content: "https://example.com/a", id: "t1", projectId: "p1", title: "阅读" },
        { content: "", id: "t2", projectId: "p1", title: "普通待办" },
        { content: "https://example.com/b", id: "t3", projectId: "p1", title: "已保存" },
      ],
      new Set(["已保存"]),
    );

    expect(parsed.items).toEqual([
      { itemKind: "link", tags: [], title: "阅读", url: "https://example.com/a" },
    ]);
    expect(parsed.deleteTasks).toEqual([
      { id: "t1", projectId: "p1" },
      { id: "t3", projectId: "p1" },
    ]);
    expect(parsed.savedTitles).toEqual(new Set(["已保存", "阅读"]));
  });

  it("解析 GitHub、知乎与 Bilibili 官方响应", () => {
    expect(parseGithubStars([{ full_name: "owner/repo", html_url: "https://github.com/owner/repo" }])).toEqual([
      { key: "https://github.com/owner/repo", title: "owner/repo", url: "https://github.com/owner/repo" },
    ]);
    expect(
      parseZhihuCollection({
        data: [{ content: { id: "2", question: { id: "1", title: "回答标题" }, type: "answer" } }],
        paging: { is_end: true },
      }),
    ).toEqual({
      isEnd: true,
      items: [{ key: "https://www.zhihu.com/question/1/answer/2", title: "回答标题", url: "https://www.zhihu.com/question/1/answer/2" }],
    });
    expect(parseBilibiliFavorites({ data: { medias: [{ bvid: "BV1", title: "收藏" }] } })).toEqual([
      { key: "https://www.bilibili.com/video/BV1", title: "收藏", url: "https://www.bilibili.com/video/BV1" },
    ]);
    expect(parseBilibiliToview({ data: { list: [{ bvid: "BV2", title: "稍后" }] } })).toEqual([
      { key: "https://www.bilibili.com/video/BV2", title: "稍后", url: "https://www.bilibili.com/video/BV2" },
    ]);
  });

  it("Inoreader 使用 article key，YouTube/X 使用平台 ID 去重", () => {
    expect(
      parseInoreaderItems([
        { key: "article_123", title: "文章", url: "https://example.com/article" },
        { key: "", title: "跳过", url: "https://example.com/no-key" },
      ]),
    ).toEqual([{ key: "article_123", title: "文章", url: "https://example.com/article" }]);
    expect(parseYoutubeItems([{ title: "视频", videoId: "abc123" }])).toEqual([
      { key: "abc123", title: "视频", url: "https://www.youtube.com/watch?v=abc123" },
    ]);
    expect(
      parseXTweets([
        { author: "作者", id: "123", text: "正文", url: "https://x.com/user/status/123" },
        { id: "123", url: "https://x.com/duplicate/status/123" },
      ]),
    ).toEqual([
      { author: "作者", id: "123", text: "正文", url: "https://x.com/user/status/123" },
    ]);
  });
});
