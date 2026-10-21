/** 普通 HTTP 抽不出正文时，用本机 Chromium 取渲染后的 HTML。浏览器不在时由调用方退回 HTTP 结果。 */
export async function fetchHtmlWithPlaywright(url: string): Promise<string> {
  const { chromium } = await import("playwright");
  const headless = process.env.INBOX_DESKTOP_PLAYWRIGHT_HEADLESS !== "0";
  const browser = await chromium.launch({ headless });
  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    });
    await page.goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" });
    return await page.content();
  } finally {
    await browser.close();
  }
}
