import { chromium, type Browser } from "playwright";

export function browserLaunchOptions(proxyServer?: string) {
  return {
    headless: false,
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
): Promise<Browser> {
  if (!display.trim()) throw new Error("DISPLAY is required");
  return chromium.launch(browserLaunchOptions(proxyServer));
}
