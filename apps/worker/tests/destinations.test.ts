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

  it("坚果云可从对象存储读取跨实例附件", async () => {
    const attachmentStore = {
      download: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      upload: vi.fn(),
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await expect(
      deliverJianguoyun(
        { password: "secret", user: "user@example.com" },
        {
          itemKind: "file",
          objectKey: "telegram/2fd785d7-47aa-4357-a59f-5039c0434c25",
          remoteName: "a.pdf",
        },
        fetcher,
        attachmentStore,
      ),
    ).resolves.toEqual({ outcome: "ok" });
    expect(attachmentStore.download).toHaveBeenCalledWith(
      "telegram/2fd785d7-47aa-4357-a59f-5039c0434c25",
    );
    expect(new Uint8Array(fetcher.mock.calls[0]?.[1]?.body as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("对象存储读取失败时不发出坚果云上传", async () => {
    const attachmentStore = {
      download: vi.fn().mockRejectedValue(new Error("gcs_object_download_failed")),
      upload: vi.fn(),
    };
    const fetcher = vi.fn();

    await expect(
      deliverJianguoyun(
        { password: "secret", user: "user@example.com" },
        {
          itemKind: "file",
          objectKey: "telegram/2fd785d7-47aa-4357-a59f-5039c0434c25",
          remoteName: "a.pdf",
        },
        fetcher,
        attachmentStore,
      ),
    ).rejects.toThrow("gcs_object_download_failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
