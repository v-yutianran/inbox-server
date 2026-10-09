import { describe, expect, it, vi } from "vitest";

import { createGcsObjectStore } from "../src/gcs-object-store";

const objectKey = "telegram/2fd785d7-47aa-4357-a59f-5039c0434c25";

describe("GCS object store", () => {
  it("不同 worker 实例可用队列中的 object key 读取已上传附件", async () => {
    const objects = new Map<string, Uint8Array>();
    const mockFetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "metadata.google.internal") {
        return new Response(JSON.stringify({ access_token: "metadata-access-token" }), {
          status: 200,
        });
      }
      if (url.pathname.startsWith("/upload/")) {
        const name = url.searchParams.get("name");
        const bytes = new Uint8Array(init?.body as ArrayBuffer);
        if (name) objects.set(name, bytes);
        return new Response("{}", { status: 200 });
      }
      const match = /\/b\/[^/]+\/o\/(.+)$/.exec(url.pathname);
      const key = decodeURIComponent(match?.[1] ?? "");
      const bytes = objects.get(key);
      return bytes
        ? new Response(bytes.buffer as ArrayBuffer, { status: 200 })
        : new Response(null, { status: 404 });
    });
    const fetcher = mockFetcher as unknown as typeof fetch;

    const collectingInstance = createGcsObjectStore({
      bucket: "inbox-worker-attachments",
      fetcher,
    });
    await collectingInstance.upload(objectKey, new Uint8Array([1, 2, 3]));
    const dispatchInstance = createGcsObjectStore({
      bucket: "inbox-worker-attachments",
      fetcher,
    });

    await expect(dispatchInstance.download(objectKey)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"),
      expect.objectContaining({ headers: { "Metadata-Flavor": "Google" } }),
    );
    expect(mockFetcher.mock.calls.some(([, init]) =>
      (init?.headers as Record<string, string> | undefined)?.Authorization ===
      "Bearer metadata-access-token",
    )).toBe(true);
  });

  it("拒绝无效 bucket、越界 object key 与 GCS HTTP 失败", async () => {
    expect(() => createGcsObjectStore({ bucket: "bad bucket" })).toThrow("gcs_bucket_invalid");
    const mockFetcher = vi.fn(async (input: string | URL, _init?: RequestInit) =>
      new URL(String(input)).hostname === "metadata.google.internal"
        ? new Response(JSON.stringify({ access_token: "metadata-access-token" }), { status: 200 })
        : new Response(null, { status: 403 }),
    );
    const fetcher = mockFetcher as unknown as typeof fetch;
    const store = createGcsObjectStore({ bucket: "inbox-worker-attachments", fetcher });

    await expect(store.download("../outside")).rejects.toThrow("gcs_object_key_invalid");
    await expect(store.upload(objectKey, new Uint8Array([1]))).rejects.toThrow(
      "gcs_object_upload_failed",
    );
    expect(mockFetcher.mock.calls[1]?.[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer metadata-access-token" }),
    );
    await expect(store.download(objectKey)).rejects.toThrow("gcs_object_download_failed:403");
    await expect(store.upload(objectKey, new Uint8Array([1]))).rejects.not.toThrow(
      "metadata-access-token",
    );
  });
});
