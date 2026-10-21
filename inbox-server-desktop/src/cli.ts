import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { InboxEngine } from "./engine.ts";
import { resolveDataDir, resolveHost, resolvePort } from "./paths.ts";
import { startServer } from "./server.ts";
import { InboxStore } from "./store.ts";

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new InboxStore(join(dataDir, "inbox.sqlite"));
const engine = new InboxEngine(store, dataDir);
engine.startScheduler();

const host = resolveHost();
const port = resolvePort();
const server = await startServer({ engine, host, port });
const address = `http://${host === "::1" ? "[::1]" : host}:${port}`;
console.log(`inbox-server-desktop 已在本机启动 ${address}`);
console.log(`数据目录 ${dataDir}`);

if (process.env.INBOX_DESKTOP_OPEN !== "0") openBrowser(address);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    engine.stopScheduler();
    server.close();
    store.close();
    process.exit(0);
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    console.log(`请在浏览器打开 ${url}`);
  });
  child.unref();
}
