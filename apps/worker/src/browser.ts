import { chromium, type Browser } from "playwright";

export async function launchHeadedBrowser(display: string): Promise<Browser> {
  if (!display.trim()) throw new Error("DISPLAY is required");
  return chromium.launch({ headless: false });
}
