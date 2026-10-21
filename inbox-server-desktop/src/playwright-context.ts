import { existsSync } from "node:fs";

import type { BrowserContextLike, PageLike } from "./browser-collect.ts";

/** 用已保存的 Playwright storageState 打开采集浏览器。默认有界面，设 INBOX_DESKTOP_PLAYWRIGHT_HEADLESS=1 可改为无头。 */
export async function openPersistentContext(profileFile: string | null): Promise<BrowserContextLike> {
  const { chromium } = await import("playwright");
  const headless = process.env.INBOX_DESKTOP_PLAYWRIGHT_HEADLESS === "1" || process.env.INBOX_DESKTOP_PLAYWRIGHT_HEADLESS === "true";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext(profileFile && existsSync(profileFile) ? { storageState: profileFile } : {});
  return {
    async newPage(): Promise<PageLike> {
      const page = await context.newPage();
      return page as unknown as PageLike;
    },
    async close(): Promise<void> {
      await context.close();
      await browser.close();
    },
    async storageState(): Promise<unknown> {
      return context.storageState();
    },
  };
}
