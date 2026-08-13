import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createImaArticleMirror,
  renderImaMarkdownCopy,
} from "../src/ima-article-mirror";

const input = {
  content: `---
title: "测试文章"
source_url: "https://example.com/article"
archived_at: "2026-08-13T12:00:00.000Z"
author: ""
published_at: ""
tags: ["inoreader"]
---

正文`,
  filename: "20260812-test.md",
  sourceUrl: "https://example.com/article?utm_source=test",
  title: "测试文章",
};

const imaFilename = "test.md";
const imaFolderId = "folder_202608";

const imaContent = `# 测试文章

正文

来源：[原文链接](https://example.com/article)`;

const credential = {
  appid: "app-id",
  bucket_name: "bucket-123",
  cos_key: "archive/test.md",
  custom_domain: "",
  expired_time: 2_000_000_000,
  region: "ap-guangzhou",
  secret_id: "temporary-id",
  secret_key: "temporary-key",
  start_time: 1_900_000_000,
  token: "temporary-token",
};

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data, msg: "ok" }), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("ima article mirror", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  async function stateDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "inbox-ima-state-"));
    directories.push(directory);
    return directory;
  }

  it("仅为 ima 副本移除 frontmatter 并在正文底部追加来源", () => {
    const content = `---
title: "测试文章"
source_url: "https://example.com/article"
archived_at: "2026-08-13T12:00:00.000Z"
author: "测试作者"
published_at: "2026-08-12"
tags: ["inoreader", "技术"]
---

正文内容`;

    expect(renderImaMarkdownCopy(content)).toBe(`# 测试文章

正文内容

来源：[原文链接](https://example.com/article)`);
    expect(content).toContain("source_url:");
  });

  it("没有合法 frontmatter 时保持 ima 副本原文", () => {
    const content = "# 标题\n\n正文里有 --- 分隔符";

    expect(renderImaMarkdownCopy(content)).toBe(content);
  });

  it("禁用时不发出 ima 或 COS 请求", async () => {
    const fetcher = vi.fn();
    const mirror = createImaArticleMirror({ enabled: false, fetcher });

    await expect(mirror.mirror(input)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("按唯一知识库名称上传 Markdown 并写入无敏完成标记", async () => {
    const directory = await stateDirectory();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        addable_knowledge_base_list: [{ id: "kb-1", name: "天然的知识库" }],
        is_end: true,
        next_cursor: "",
      }))
      .mockResolvedValueOnce(response({
        current_path: [],
        is_end: true,
        knowledge_list: [{ folder_id: imaFolderId, name: "202608" }],
        next_cursor: "",
      }))
      .mockResolvedValueOnce(response({ results: [{ is_repeated: false, name: input.filename }] }))
      .mockResolvedValueOnce(response({ cos_credential: credential, media_id: "media-1" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(response({ media_id: "media-1" }));
    const log = vi.fn();
    const mirror = createImaArticleMirror({
      apiKey: "api-secret",
      clientId: "client-secret",
      enabled: true,
      fetcher,
      knowledgeBaseName: "天然的知识库",
      log,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      stateDirectory: directory,
    });

    await expect(mirror.mirror(input)).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://ima.qq.com/openapi/wiki/v1/get_addable_knowledge_base_list",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://ima.qq.com/openapi/wiki/v1/get_knowledge_list",
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      cursor: "",
      knowledge_base_id: "kb-1",
      limit: 50,
    });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      folder_id: imaFolderId,
      knowledge_base_id: "kb-1",
      params: [{ media_type: 7, name: imaFilename }],
    });
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      content_type: "text/markdown",
      file_ext: "md",
      file_name: imaFilename,
      file_size: Buffer.byteLength(imaContent),
      knowledge_base_id: "kb-1",
    });
    expect(fetcher.mock.calls[4]?.[0]).toBe(
      "https://bucket-123.cos.ap-guangzhou.myqcloud.com/archive/test.md",
    );
    expect(fetcher.mock.calls[4]?.[1]).toEqual(expect.objectContaining({
      body: Buffer.from(imaContent),
      method: "PUT",
    }));
    expect(JSON.parse(String(fetcher.mock.calls[5]?.[1]?.body))).toEqual({
      file_info: {
        cos_key: credential.cos_key,
        file_name: imaFilename,
        file_size: Buffer.byteLength(imaContent),
        last_modify_time: 1_786_536_000,
        password: "",
      },
      folder_id: imaFolderId,
      knowledge_base_id: "kb-1",
      media_id: "media-1",
      media_type: 7,
      title: imaFilename,
    });

    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const marker = await readFile(join(directory, files[0]!), "utf8");
    expect(marker).not.toContain(input.sourceUrl);
    expect(marker).not.toContain(input.content);
    expect(marker).not.toContain("api-secret");
    expect(log).toHaveBeenCalledWith("article.ima_mirror.succeeded", {
      durationBucket: expect.any(String),
      provider: "ima",
      result: "succeeded",
      stage: "complete",
    });
  });

  it("月份文件夹不存在时 fail closed 且不创建媒体", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        addable_knowledge_base_list: [{ id: "kb-1", name: "天然的知识库" }],
        is_end: true,
        next_cursor: "",
      }))
      .mockResolvedValueOnce(response({
        current_path: [],
        is_end: true,
        knowledge_list: [],
        next_cursor: "",
      }));

    await expect(createImaArticleMirror({
      apiKey: "api-secret",
      clientId: "client-secret",
      enabled: true,
      fetcher,
      knowledgeBaseName: "天然的知识库",
      stateDirectory: await stateDirectory(),
    }).mirror(input)).rejects.toThrow("ima_month_folder_not_unique");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("已有完成标记时重投跳过所有远程请求", async () => {
    const directory = await stateDirectory();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        addable_knowledge_base_list: [{ id: "kb-1", name: "天然的知识库" }],
        is_end: true,
        next_cursor: "",
      }))
      .mockResolvedValueOnce(response({ current_path: [], is_end: true, knowledge_list: [{ folder_id: imaFolderId, name: "202608" }], next_cursor: "" }))
      .mockResolvedValueOnce(response({ results: [{ is_repeated: false, name: input.filename }] }))
      .mockResolvedValueOnce(response({ cos_credential: credential, media_id: "media-1" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(response({ media_id: "media-1" }));
    const options = {
      apiKey: "api-secret",
      clientId: "client-secret",
      enabled: true as const,
      fetcher,
      knowledgeBaseName: "天然的知识库",
      stateDirectory: directory,
    };

    await createImaArticleMirror(options).mirror(input);
    fetcher.mockClear();
    await createImaArticleMirror(options).mirror(input);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("知识库名称不唯一时 fail closed", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      addable_knowledge_base_list: [
        { id: "kb-1", name: "天然的知识库" },
        { id: "kb-2", name: "天然的知识库" },
      ],
      is_end: true,
      next_cursor: "",
    }));
    const mirror = createImaArticleMirror({
      apiKey: "api-secret",
      clientId: "client-secret",
      enabled: true,
      fetcher,
      knowledgeBaseName: "天然的知识库",
      stateDirectory: await stateDirectory(),
    });

    await expect(mirror.mirror(input)).rejects.toThrow("ima_knowledge_base_not_unique");
  });

  it("无本地完成标记的同名文件不覆盖也不自动改名", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        addable_knowledge_base_list: [{ id: "kb-1", name: "天然的知识库" }],
        is_end: true,
        next_cursor: "",
      }))
      .mockResolvedValueOnce(response({ current_path: [], is_end: true, knowledge_list: [{ folder_id: imaFolderId, name: "202608" }], next_cursor: "" }))
      .mockResolvedValueOnce(response({ results: [{ is_repeated: true, name: input.filename }] }));
    const mirror = createImaArticleMirror({
      apiKey: "api-secret",
      clientId: "client-secret",
      enabled: true,
      fetcher,
      knowledgeBaseName: "天然的知识库",
      stateDirectory: await stateDirectory(),
    });

    await expect(mirror.mirror(input)).rejects.toThrow("ima_duplicate_unverified");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("COS 上传失败时不调用 add_knowledge 且日志不泄露输入", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({
        addable_knowledge_base_list: [{ id: "kb-1", name: "天然的知识库" }],
        is_end: true,
        next_cursor: "",
      }))
      .mockResolvedValueOnce(response({ current_path: [], is_end: true, knowledge_list: [{ folder_id: imaFolderId, name: "202608" }], next_cursor: "" }))
      .mockResolvedValueOnce(response({ results: [{ is_repeated: false, name: input.filename }] }))
      .mockResolvedValueOnce(response({ cos_credential: credential, media_id: "media-1" }))
      .mockResolvedValueOnce(new Response("secret upstream body", { status: 500 }));
    const log = vi.fn();
    const mirror = createImaArticleMirror({
      apiKey: "api-secret",
      clientId: "client-secret",
      enabled: true,
      fetcher,
      knowledgeBaseName: "天然的知识库",
      log,
      stateDirectory: await stateDirectory(),
    });

    await expect(mirror.mirror(input)).rejects.toThrow("ima_cos_upload_failed");
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.sourceUrl);
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.filename);
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.content);
    expect(JSON.stringify(log.mock.calls)).not.toContain("api-secret");
    expect(log).toHaveBeenCalledWith("article.ima_mirror.failed", {
      durationBucket: expect.any(String),
      provider: "ima",
      reason: "cos_upload_failed",
      result: "failed",
      stage: "cos_upload",
    });
  });
});
