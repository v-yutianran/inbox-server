import { readFile } from "node:fs/promises";

import { formatFlomoContent, type DispatchItem } from "@inbox/domain";

export type DeliveryResult =
  | { readonly outcome: "ok" }
  | { readonly outcome: "quota" }
  | { readonly outcome: "fail"; readonly status?: number };

export async function deliverCubox(
  apiUrl: string,
  item: Extract<DispatchItem, { itemKind: "link" }>,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const response = await fetcher(apiUrl, {
    body: JSON.stringify({
      content: item.url,
      tags: item.tags ?? [],
      title: item.title || item.url,
      type: "url",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response.ok ? { outcome: "ok" } : { outcome: "fail", status: response.status };
  }
  const code = isRecord(body) ? body.code : undefined;
  if (code === 200) return { outcome: "ok" };
  if (code === -3030) return { outcome: "quota" };
  return { outcome: "fail", status: response.status };
}

export async function deliverFlomo(
  webhook: string,
  item: Extract<DispatchItem, { itemKind: "text" }>,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const response = await fetcher(webhook, {
    body: JSON.stringify({
      content: formatFlomoContent(item.content, item.tags ?? []),
      content_type: "markdown",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { outcome: "fail", status: response.status };
  }
  return isRecord(body) && body.code === 0
    ? { outcome: "ok" }
    : { outcome: "fail", status: response.status };
}

export async function deliverJianguoyun(
  config: {
    readonly basePath?: string;
    readonly baseUrl?: string;
    readonly password: string;
    readonly user: string;
  },
  item: Extract<DispatchItem, { itemKind: "file" }>,
  fetcher: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const baseUrl = (config.baseUrl ?? "https://dav.jianguoyun.com/dav").replace(/\/$/, "");
  const remotePath = joinRemotePath(config.basePath ?? "/我的坚果云", item.remoteName);
  const response = await fetcher(`${baseUrl}${encodeRemotePath(remotePath)}`, {
    body: await readFile(item.localPath),
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`,
      "Content-Type": "application/octet-stream",
    },
    method: "PUT",
  });
  return response.ok
    ? { outcome: "ok" }
    : { outcome: "fail", status: response.status };
}

function joinRemotePath(basePath: string, remoteName: string): string {
  const parts = `${basePath}/${remoteName}`.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === ".." || part === ".")) {
    throw new Error("unsafe WebDAV remote path");
  }
  return `/${parts.join("/")}`;
}

function encodeRemotePath(path: string): string {
  return `/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
