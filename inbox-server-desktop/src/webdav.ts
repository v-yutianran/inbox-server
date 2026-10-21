export async function deliverJianguoyun(options: {
  baseUrl?: string;
  content: Uint8Array;
  fetcher?: typeof fetch;
  password: string;
  remoteName: string;
  user: string;
}): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = (options.baseUrl || "https://dav.jianguoyun.com/dav").replace(/\/$/, "");
  const parts = `/${options.remoteName}`.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("unsafe WebDAV remote path");
  const remotePath = `/${parts.map(encodeURIComponent).join("/")}`;
  const response = await fetcher(`${baseUrl}${remotePath}`, {
    body: Buffer.from(options.content),
    headers: {
      authorization: `Basic ${Buffer.from(`${options.user}:${options.password}`).toString("base64")}`,
      "content-type": "application/octet-stream",
    },
    method: "PUT",
  });
  if (!response.ok) throw new Error(`jianguoyun failed: ${response.status}`);
}
