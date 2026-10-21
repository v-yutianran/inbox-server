import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Server } from "node:http";

import { buildArchiveFilename, planQueueBatches, QueueBatchError, RATE_POLICIES } from "../src/domain.ts";
import { InboxEngine } from "../src/engine.ts";
import { startServer } from "../src/server.ts";
import { InboxStore } from "../src/store.ts";

const html = `<!doctype html><html><head><title>本地文章</title></head><body><p>${"正文".repeat(150)}</p></body></html>`;

function tempEngine(fetchImpl?: typeof fetch, policies = RATE_POLICIES): { dir: string; store: InboxStore; engine: InboxEngine } {
  const dir = mkdtempSync(join(tmpdir(), "inbox-desktop-"));
  const store = new InboxStore(join(dir, "inbox.sqlite"));
  const engine = new InboxEngine(store, dir, { fetchImpl, policies });
  return { dir, store, engine };
}

describe("队列与文件名", () => {
  test("超过 100 条或 256KB 时先整批校验再切开", () => {
    const jobs = Array.from({ length: 101 }, (_, index) => ({ id: index }));
    const batches = planQueueBatches(jobs);
    assert.deepEqual(batches.map((batch) => batch.length), [100, 1]);

    const chunk = "汉".repeat(20_000);
    const wide = planQueueBatches(Array.from({ length: 5 }, () => ({ text: chunk })));
    assert.ok(wide.length >= 2);
    assert.equal(wide.flat().length, 5);

    assert.throws(() => planQueueBatches([{ blob: "a".repeat(130_000) }]), QueueBatchError);
  });

  test("文章文件名按上海日期截断到 171 字节", () => {
    const filename = buildArchiveFilename("标".repeat(80), new Date("2026-10-21T00:00:00Z"), "ab12cd34");
    assert.ok(filename.startsWith("20261021-"));
    assert.ok(filename.endsWith("-ab12cd34.md"));
    assert.ok(Buffer.byteLength(filename) <= 171);
  });
});

describe("核心收件流", () => {
  test("链接写入本地库并归档文章，重复收录不会再写一份", async () => {
    const seen: string[] = [];
    const { dir, store, engine } = tempEngine(async (input, init) => {
      seen.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "POST") {
        return Response.json({ code: 200 });
      }
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    });
    const settings = store.settings();
    settings.forward.cuboxUrl = "https://cubox.example/api";
    store.saveSettings(settings);

    const first = await engine.capture({ itemKind: "link", url: "https://example.com/story", title: "一篇故事" });
    assert.equal(first.duplicate, false);
    assert.equal(first.status, "done");
    const again = await engine.capture({ itemKind: "link", url: "https://example.com/story", title: "一篇故事" });
    assert.equal(again.duplicate, true);

    const items = store.listItems();
    assert.equal(items.filter((item) => item.itemKind === "link").length, 1);
    assert.equal(items.filter((item) => item.itemKind === "article" && item.status === "done").length, 1);
    const link = items.find((item) => item.itemKind === "link");
    assert.ok(link?.destinationPath && readFileSync(link.destinationPath, "utf8").includes("https://example.com/story"));
    const article = store.listArticleEvents()[0];
    assert.equal(article?.status, "committed");
    assert.ok(article?.filename && readFileSync(article.filename, "utf8").includes("本地文章"));
    assert.ok(article.filename.includes(`${dir}/archive/sources/article/`));
    assert.ok(seen.some((call) => call.startsWith("POST https://cubox.example/api")));
    store.close();
  });

  test("超过每日额度的链接会延期，且不会写入本地文件", async () => {
    const policies = structuredClone(RATE_POLICIES);
    policies.link = { ...policies.link, dailyLimit: 1 };
    const { store, engine } = tempEngine(async () => new Response(html), policies);
    const settings = store.settings();
    settings.archiveEnabled = false;
    store.saveSettings(settings);

    const first = await engine.capture({ itemKind: "link", url: "https://example.com/one", title: "一" });
    const second = await engine.capture({ itemKind: "link", url: "https://example.com/two", title: "二" });
    assert.equal(first.status, "done");
    assert.equal(second.status, "deferred");
    assert.equal(store.listItems().filter((item) => item.destinationPath).length, 1);
    store.close();
  });

  test("滴答清单逐条删除，失败即停止，已发布的链接仍保留", async () => {
    const deletes: string[] = [];
    let fail = true;
    const { store, engine } = tempEngine(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/data")) {
        return Response.json({
          tasks: [
            { id: "1", projectId: "inbox", title: "一", content: "https://example.com/a" },
            { id: "2", projectId: "inbox", title: "二", content: "https://example.com/b" },
            { id: "3", projectId: "inbox", title: "三", content: "https://example.com/c" },
          ],
        });
      }
      deletes.push(`${init?.method} ${url}`);
      if (fail && url.endsWith("/2")) return new Response("no", { status: 500 });
      return new Response(null, { status: 200 });
    });
    const settings = store.settings();
    settings.archiveEnabled = false;
    settings.sources.dida.enabled = true;
    settings.sources.dida.accessToken = "token-a";
    store.saveSettings(settings);

    const first = await engine.sync("manual");
    assert.equal(first.status, "failed");
    assert.match(first.error ?? "", /Dida delete request failed: 500/);
    assert.deepEqual(deletes.map((call) => call.split("/").at(-1)), ["1", "2"]);
    assert.equal(store.listItems().filter((item) => item.status === "done").length, 3);

    fail = false;
    deletes.length = 0;
    const second = await engine.sync("manual");
    assert.equal(second.status, "done");
    assert.deepEqual(deletes.map((call) => call.split("/").at(-1)), ["1", "2", "3"]);
    assert.equal(store.listItems().length, 3);
    store.close();
  });

  test("GitHub stars 增量只收录新链接", async () => {
    const pages: string[] = [];
    const { store, engine } = tempEngine(async (input) => {
      const url = String(input);
      pages.push(url);
      if (url.includes("page=1")) {
        return Response.json([{ full_name: "fishyer/inbox", html_url: "https://github.com/fishyer/inbox" }]);
      }
      return Response.json([]);
    });
    const settings = store.settings();
    settings.archiveEnabled = false;
    settings.sources.github_stars.enabled = true;
    settings.sources.github_stars.token = "gh";
    store.saveSettings(settings);
    await engine.sync("manual");
    await engine.sync("manual");
    assert.equal(pages.length, 2);
    assert.equal(store.listItems().length, 1);
    store.close();
  });

  test("HTTP 正文太短时改用 Playwright 取回的 HTML", async () => {
    let browserCalls = 0;
    const dir = mkdtempSync(join(tmpdir(), "inbox-desktop-pw-"));
    const store = new InboxStore(join(dir, "inbox.sqlite"));
    const engine = new InboxEngine(store, dir, {
      fetchImpl: async () => new Response("<html><head><title>壳</title></head><body>加载中</body></html>"),
      playwrightFetch: async () => {
        browserCalls += 1;
        return html;
      },
    });
    const saved = await engine.capture({
      itemKind: "article",
      title: "渲染后的文章",
      url: "https://example.com/rendered",
    });
    assert.equal(saved.status, "done");
    assert.equal(browserCalls, 1);
    assert.equal(store.listArticleEvents()[0]?.status, "committed");
    assert.match(readFileSync(store.listArticleEvents()[0]?.filename ?? "", "utf8"), /正文/);
    store.close();
  });

  test("本机文件复制进本地资料库", async () => {
    const { dir, store, engine } = tempEngine();
    const source = join(dir, "note.txt");
    writeFileSync(source, "hello file");
    const result = await engine.capture({ itemKind: "file", localPath: source, remoteName: "note.txt" });
    assert.equal(result.status, "done");
    const item = store.listItems()[0];
    assert.equal(item && readFileSync(item.destinationPath ?? "", "utf8"), "hello file");
    store.close();
  });
});

describe("云端导入", () => {
  test("导入明文历史和可重放任务，密文信封只计数", async () => {
    const { store, engine } = tempEngine(async () => new Response(html));
    const settings = store.settings();
    settings.archiveEnabled = false;
    store.saveSettings(settings);
    const summary = engine.importCloud({
      format: "inbox-cloud-export-v1",
      encryptedEnvelopeCount: 2,
      workerJobEnvelopes: [{ ciphertext: "SECRET-CIPHER" }],
      articleArchiveEvents: [{
        source_url: "https://example.com/old",
        url_fingerprint: "fp-1",
        title: "旧文",
        status: "committed",
        filename: "old.md",
        occurred_at: "2026-10-01T00:00:00Z",
      }],
      worker_state: [{ key: "baseline:github_stars", value: { knownKeys: ["https://github.com/old"] } }],
      jobs: [
        {
          jobId: "11111111-1111-4111-8111-111111111111",
          dedupeKey: "dispatch:link:done",
          kind: "dispatch-item",
          itemKind: "link",
          status: "done",
          createdAt: "2026-10-01T00:00:00Z",
        },
        {
          jobId: "22222222-2222-4222-8222-222222222222",
          dedupeKey: "dispatch:link:pending",
          kind: "dispatch-item",
          itemKind: "link",
          status: "deferred",
          createdAt: "2026-10-02T00:00:00Z",
          payload: { itemKind: "link", url: "https://example.com/pending", title: "待处理" },
        },
      ],
    });
    assert.equal(summary.articleEvents, 1);
    assert.equal(summary.cloudJobs, 2);
    assert.equal(summary.requeued, 1);
    assert.equal(summary.skippedEncryptedEnvelopes, 2);
    await engine.drain();
    assert.equal(store.listItems().some((item) => item.url === "https://example.com/pending" && item.status === "done"), true);
    const raw = JSON.stringify(store.db.prepare("SELECT key, value FROM worker_state").all());
    assert.equal(raw.includes("SECRET-CIPHER"), false);
    const again = engine.importCloud({
      format: "inbox-cloud-export-v1",
      articleArchiveEvents: [{
        sourceUrl: "https://example.com/old",
        urlFingerprint: "fp-1",
        title: "旧文",
        status: "committed",
        filename: "old.md",
        occurredAt: "2026-10-01T00:00:00Z",
      }],
    });
    assert.equal(again.articleEvents, 0);
    assert.equal(store.listArticleEvents().length, 1);
    store.close();
  });
});

describe("本机 HTTP", () => {
  let server: Server;
  let base: string;
  let store: InboxStore;

  before(async () => {
    const ctx = tempEngine(async () => new Response(html));
    store = ctx.store;
    server = await startServer({ engine: ctx.engine, host: "127.0.0.1", port: 0 });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  });

  test("收录链接后总览能看到完成的收件", async () => {
    const created = await fetch(`${base}/api/capture`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemKind: "link", url: "https://example.com/http", title: "接口来的" }),
    });
    assert.equal(created.status, 200);
    const body = await created.json() as { status: string };
    assert.equal(body.status, "done");
    const overview = await fetch(`${base}/api/overview`);
    const page = await overview.json() as { items: Array<{ title: string | null; status: string }> };
    assert.ok(page.items.some((item) => item.title === "接口来的" && item.status === "done"));
    const ui = await fetch(`${base}/`);
    assert.match(await ui.text(), /本地收件匣/);
  });
});
