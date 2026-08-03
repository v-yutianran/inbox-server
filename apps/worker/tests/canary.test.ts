import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";

import { createArticleArchiver } from "../src/article-archive";
import {
  createCanaryArticleItem,
  createDryRunCanaryRepository,
} from "../src/canary";
import type { Channels } from "../src/channels";

const channels: Channels = {
  article_archive: {
    articles_dir: "references/article",
    browser_timeout_seconds: 45,
    daily_limit: 10_000,
    defuddle_timeout_seconds: 30,
    enabled: true,
    http_timeout_seconds: 30,
    interval_seconds: 5,
    max_html_bytes: 8_000_000,
    max_output_bytes: 10_000_000,
    min_visible_characters: 200,
    rate_window_count: 60,
    rate_window_seconds: 3_600,
    repository_dir: "/canary/dry-run",
  },
  credentials: {},
  destinations: {},
  llm: {},
  notification: {},
  sources: {},
};
const template = "---\ntitle: <%~ it.title_yaml %>\nsource_url: <%~ it.source_url_yaml %>\n---\n\n<%~ it.markdown %>\n";

function browserWith(html: string): Browser {
  return {
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue({
        content: vi.fn().mockResolvedValue(html),
        evaluate: vi.fn().mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(undefined),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        waitForSelector: vi.fn().mockResolvedValue(undefined),
        waitForTimeout: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  } as unknown as Browser;
}

describe("isolated article canary", () => {
  it.each([
    ["direct", "canary-direct.html", "canary-browser.html", 1, false],
    ["short_rejected", "canary-short.html", "canary-short.html", 0, true],
    ["browser_fallback", "canary-short.html", "canary-browser.html", 1, true],
  ] as const)("固定 fixture 覆盖 %s 且 dry-run sink 零真实副作用", async (
    path,
    directFixture,
    browserFixture,
    expectedSaved,
    expectedBrowser,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-canary-"));
    const templatePath = join(directory, "article.md.eta");
    const directHtml = await readFile(
      new URL(`./fixtures/${directFixture}`, import.meta.url),
      "utf8",
    );
    const browserHtml = await readFile(
      new URL(`./fixtures/${browserFixture}`, import.meta.url),
      "utf8",
    );
    const fetcher = vi.fn().mockResolvedValue(
      new Response(directHtml, { headers: { "Content-Type": "text/html" } }),
    );
    const browser = browserWith(browserHtml);
    const dryRun = createDryRunCanaryRepository();
    const log = vi.fn();
    const recordEvent = vi.fn().mockResolvedValue(undefined);
    await writeFile(templatePath, template);

    try {
      const archive = createArticleArchiver({
        browser,
        channels,
        fetcher,
        log,
        recordEvent,
        repository: dryRun.repository,
        templatePath,
      });
      const item = createCanaryArticleItem({
        path,
        requestedAt: "2030-01-01T00:00:00.000Z",
        runId: "run-001",
      });

      await expect(archive(item)).resolves.toEqual({ outcome: "ok" });
      expect(dryRun.snapshot().saved).toHaveLength(expectedSaved);
      expect(dryRun.snapshot().externalWriteCount).toBe(0);
      expect(browser.newContext).toHaveBeenCalledTimes(expectedBrowser ? 1 : 0);
      expect(JSON.stringify(dryRun.snapshot())).not.toContain("合成正文");
      expect(item.tags).toContain("canary:run-001");
      if (path === "short_rejected") {
        expect(recordEvent).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "short_content", status: "skipped" }),
        );
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
