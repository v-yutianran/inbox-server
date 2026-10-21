import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, shell } from "electron";

import { InboxEngine } from "./engine.ts";
import { resolveDataDir, resolvePort } from "./paths.ts";
import { startServer } from "./server.ts";
import { InboxStore } from "./store.ts";

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const store = new InboxStore(join(dataDir, "inbox.sqlite"));
const engine = new InboxEngine(store, dataDir);

let server: Awaited<ReturnType<typeof startServer>> | null = null;
let mainWindow: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    void openWindow();
  }).catch((error: unknown) => {
    console.error(error);
    shutdown();
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    shutdown();
    app.quit();
  });
}

async function openWindow(): Promise<void> {
  engine.startScheduler();
  const host = "127.0.0.1";
  const port = resolvePort();
  server = await startServer({ engine, host, port });
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 880,
    minHeight: 640,
    title: "本地收件匣",
    backgroundColor: "#f3efe4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  await mainWindow.loadURL(`http://${host}:${port}/`);
  const screenshot = process.env.INBOX_DESKTOP_SCREENSHOT?.trim();
  if (screenshot) {
    await mainWindow.webContents.executeJavaScript("document.body.innerText.includes('本地收件匣')");
    const image = await mainWindow.capturePage();
    writeFileSync(screenshot, image.toPNG());
    shutdown();
    app.exit(0);
  }
}

function shutdown(): void {
  engine.stopScheduler();
  server?.close();
  server = null;
  try {
    store.close();
  } catch {
    // 窗口关闭和退出可能各走一次。
  }
}
