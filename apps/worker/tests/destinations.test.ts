import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { deliverCubox, deliverFlomo, deliverJianguoyun } from "../src/destinations";

describe("destinations", () => {
  it("Cubox 保持数组 tags 与业务 code 契约", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200 }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );

    await expect(
      deliverCubox(
        "https://cubox.example/api",
        { itemKind: "link", tags: ["github", "效率"], title: "Example", url: "https://example.com" },
        fetcher,
      ),
    ).resolves.toEqual({ outcome: "ok" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      content: "https://example.com",
      tags: ["github", "效率"],
      title: "Example",
      type: "url",
    });
  });

  it("Cubox -3030 映射为 quota", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: -3030 }), { status: 200 }),
    );

    await expect(
      deliverCubox(
        "https://cubox.example/api",
        { itemKind: "link", url: "https://example.com" },
        fetcher,
      ),
    ).resolves.toEqual({ outcome: "quota" });
  });

  it("Flomo 保持 markdown payload", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0 }), { status: 200 }),
    );

    await expect(
      deliverFlomo(
        "https://flomo.example/webhook",
        { content: "正文", itemKind: "text", tags: ["效率"] },
        fetcher,
      ),
    ).resolves.toEqual({ outcome: "ok" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      content: "#效率 正文",
      content_type: "markdown",
    });
  });

  it("坚果云使用 Basic Auth PUT 上传 PVC 文件且不泄露密码到 URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-webdav-"));
    const localPath = join(directory, "file.txt");
    await writeFile(localPath, "hello");
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await expect(
      deliverJianguoyun(
        { basePath: "/我的坚果云", password: "secret", user: "user@example.com" },
        { itemKind: "file", localPath, remoteName: "收件箱/file.txt" },
        fetcher,
      ),
    ).resolves.toEqual({ outcome: "ok" });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toContain("/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/");
    expect(String(url)).not.toContain("secret");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual(expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }));
  });
});
