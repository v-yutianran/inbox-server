import { chromium, type Browser } from "playwright";

export function browserLaunchOptions(proxyServer: string | undefined, timeoutMs: number) {
  return {
    headless: false,
    timeout: timeoutMs,
    ...(proxyServer
      ? {
          args: ["--disable-http2", "--disable-quic"],
          proxy: { server: proxyServer },
        }
      : {}),
  };
}

export async function launchHeadedBrowser(
  display: string,
  proxyServer?: string,
  timeoutMs = 900_000,
): Promise<Browser> {
  if (!display.trim()) throw new Error("DISPLAY is required");
  return chromium.launch(browserLaunchOptions(proxyServer, timeoutMs));
}

export async function connectCloudflareBrowser(
  accountId: string,
  token: string,
  timeoutMs: number,
): Promise<Browser> {
  const endpoint = `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser?keep_alive=60000`;
  try {
    return await chromium.connectOverCDP(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
    });
  } catch {
    throw new Error("Cloudflare Browser Run connection failed");
  }
}

export async function runBrowserBatch<T>(
  needsBrowser: boolean,
  connect: () => Promise<Browser>,
  processBatch: (browser: Browser | undefined) => Promise<T>,
): Promise<T> {
  if (!needsBrowser) return processBatch(undefined);
  const browser = await connect();
  try {
    return await processBatch(browser);
  } finally {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close");
    } catch {
      throw new Error("Cloudflare Browser Run cleanup failed");
    } finally {
      await browser.close();
    }
  }
}
