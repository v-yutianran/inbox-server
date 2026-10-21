import { homedir } from "node:os";
import { join } from "node:path";

/** 数据目录按操作系统落到用户本机，方便以后把整个文件夹拷出仓库单独运行。 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INBOX_DESKTOP_HOME?.trim();
  if (override) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "inbox-server-desktop");
  }
  const base = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(base, "inbox-server-desktop");
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INBOX_DESKTOP_PORT?.trim() || "4731";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`INBOX_DESKTOP_PORT 无效: ${raw}`);
  }
  return port;
}

/** 只允许回环地址，避免这台机器上的收件匣被局域网或隧道暴露出去。 */
export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.INBOX_DESKTOP_HOST?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("inbox-server-desktop 只监听本机回环地址");
  }
  return host;
}
