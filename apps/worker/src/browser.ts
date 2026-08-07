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
