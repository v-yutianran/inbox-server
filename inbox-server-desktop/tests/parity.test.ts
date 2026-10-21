import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractArticle } from "../src/archive.ts";
import { commitArchiveFile } from "../src/archive-git.ts";
import { collectBrowserSource, type PageLike } from "../src/browser-collect.ts";
import { InboxEngine } from "../src/engine.ts";
import { mirrorToIma, renderImaMarkdownCopy } from "../src/ima.ts";
import { buildMimeMessage, formatCollectionNotification, notifyTelegram, sendSmtpMail } from "../src/notify.ts";
import { parseBilibiliFavorites, parseXTweets, parseYoutubeItems, parseZhihuCollection } from "../src/parsers.ts";
import { credentialToStorageState, electronCookiesToStorageState, writeProfile } from "../src/profiles.ts";
import { overlaySettings, readSettingsFile } from "../src/settings.ts";
import { generateSmartTags } from "../src/smart-tags.ts";
import { InboxStore } from "../src/store.ts";
import { deliverJianguoyun } from "../src/webdav.ts";
import { buildZhihuDocument, resolveZhihuArticleRequest } from "../src/zhihu-article.ts";

const html = `<!doctype html><html><head><title>本地文章</title></head><body><p>${"正文".repeat(150)}</p></body></html>`;

function tempStore(): { dir: string; store: InboxStore } {
  const dir = mkdtempSync(join(tmpdir(), "inbox-parity-"));
  return { dir, store: new InboxStore(join(dir, "inbox.sqlite")) };
}

describe("浏览器来源解析", () => {
  test("知乎、B 站、YouTube、X 的解析结果可入队", () => {
    const zhihu = parseZhihuCollection({
      data: [{ content: { type: "answer", id: "9", question: { id: "3", title: "问题" } } }],
      paging: { is_end: true },
    });
    assert.equal(zhihu.items[0]?.url, "https://www.zhihu.com/question/3/answer/9");
    const videos = parseBilibiliFavorites({ data: { medias: [{ bvid: "BV1xx", title: "收藏" }] } });
    assert.equal(videos[0]?.url, "https://www.bilibili.com/video/BV1xx");
    const youtube = parseYoutubeItems([{ title: "稍后", videoId: "abc" }]);
    assert.equal(youtube[0]?.url, "https://www.youtube.com/watch?v=abc");
    const tweets = parseXTweets([{ author: "作者", id: "42", text: "正文", url: "https://x.com/a/status/42" }]);
    assert.equal(tweets[0]?.id, "42");
  });

  test("假页面采集知乎收藏和 Inoreader 星标，并按 key 去重", async () => {
    const page = fakePage(async (_fn, arg) => {
      const target = String(arg ?? "");
      if (target.includes("/collections/")) {
        return {
          body: JSON.stringify({
            data: [{ content: { id: "1", title: "知乎文", type: "article", url: "https://zhuanlan.zhihu.com/p/1" } }],
            paging: { is_end: true },
          }),
          status: 200,
        };
      }
      return { body: "[]", status: 200 };
    });
    const first = await collectBrowserSource("zhihu", { collection_id: "col" }, contextOf(page), () => new Set());
    assert.equal(first.items[0]?.itemKind === "link" ? first.items[0].url : "", "https://zhuanlan.zhihu.com/p/1");
    const known = new Set(["https://zhuanlan.zhihu.com/p/1"]);
    const second = await collectBrowserSource("zhihu", { collection_id: "col" }, contextOf(page), () => known);
    assert.equal(second.items.length, 0);

    const starred = fakePage(async (fn) => {
      if (fn.toString().includes("article_title")) return [{ key: "article_9", title: "星标", url: "https://example.com/star" }];
      return [];
    });
    const inoreader = await collectBrowserSource("inoreader", {}, contextOf(starred), () => new Set());
    assert.equal(inoreader.items.length, 1);
    assert.equal(inoreader.stateUpdates[0]?.key, "baseline:inoreader");

    const bilibili = fakePage(async (_fn, arg) => {
      const pageNumber = /pn=(\d+)/.exec(String(arg))?.[1];
      const medias = pageNumber === "1" ? [{ bvid: "BV1xx", title: "收藏" }] : [];
      return { body: JSON.stringify({ data: { medias } }), status: 200 };
    });
    const favorites = await collectBrowserSource("bilibili", { media_id: "99" }, contextOf(bilibili), () => new Set());
    assert.equal(favorites.items.length, 1);

    const youtube = fakePage(async (fn) => (fn.toString().includes("watch?v=") ? [{ title: "稍后", videoId: "abc" }] : []));
    const watchLater = await collectBrowserSource("youtube", {}, contextOf(youtube), () => new Set());
    assert.equal(watchLater.items[0]?.itemKind === "link" ? watchLater.items[0].url : "", "https://www.youtube.com/watch?v=abc");

    const tweets = fakePage(async (fn) => (fn.toString().includes("tweet") ? [{ author: "作者", id: "7", text: "书签", url: "https://x.com/a/status/7" }] : []));
    const bookmarks = await collectBrowserSource("x_bookmarks", {}, contextOf(tweets), () => new Set());
    assert.equal(bookmarks.stateUpdates.some((update) => update.key === "baseline:x"), true);
    await assert.rejects(() => collectBrowserSource("x_likes", {}, contextOf(tweets), () => new Set()), /username/);
  });
});

describe("登录态与设置", () => {
  test("cookie 和 Electron cookie 都能写成 storageState，密钥不会从公开设置漏出", () => {
    const zhihu = credentialToStorageState("zhihu", { z_c0: "secret-cookie" });
    assert.equal(zhihu.cookies[0]?.name, "z_c0");
    const fromWindow = electronCookiesToStorageState([{ domain: ".x.com", name: "auth_token", value: "tok" }]);
    assert.equal(fromWindow.cookies[0]?.sameSite, "Lax");
    const { dir, store } = tempStore();
    const settings = store.settings();
    settings.sources.dida.accessToken = "keep-me";
    store.saveSettings(settings);
    const patched = overlaySettings(store.settings(), { sources: { dida: { accessToken: "" } } });
    assert.equal(patched.sources.dida.accessToken, "keep-me");
    const cleared = overlaySettings(patched, { sources: { dida: { accessToken: null } } });
    assert.equal(cleared.sources.dida.accessToken, "");
    assert.equal(store.publicSettings().sources.dida.accessTokenSet, true);
    const file = readSettingsFile(join(dir, "inbox.sqlite"));
    assert.equal(file?.sources.dida.accessToken, "keep-me");
    assert.equal(JSON.stringify(store.publicSettings()).includes("keep-me"), false);
    writeProfile(join(dir, "profiles", "zhihu.json"), zhihu);
    store.close();
  });
});

describe("归档、转发与通知", () => {
  test("Defuddle 或回退抽取都保留标题，本机 Git 能提交文章", async () => {
    const extracted = await extractArticle(html, "https://example.com/story");
    assert.match(`${extracted.title}\n${extracted.markdown}`, /本地文章/);
    const { dir, store } = tempStore();
    const repo = join(dir, "archive");
    const file = join(repo, "sources", "article", "note.md");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, "sources", "article"), { recursive: true });
    writeFileSync(file, "hello archive\n");
    await commitArchiveFile(repo, "sources/article/note.md");
    const log = execFileSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" });
    assert.match(log, /archive sources\/article\/note.md/);
    store.close();
  });

  test("文本标签、坚果云、Telegram 通知和 ima 镜像走可替换的 HTTP", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("bigmodel.cn")) return Response.json({ choices: [{ message: { content: "读书笔记,时间管理,效率工具" } }] });
      if (url.includes("sendMessage")) return Response.json({ ok: true });
      if (url.endsWith("/dav/note.txt")) return new Response(null, { status: 201 });
      if (url.endsWith("/get_addable_knowledge_base_list")) {
        return Response.json({ code: 0, data: { addable_knowledge_base_list: [{ id: "kb", name: "收件" }], is_end: true, next_cursor: "" } });
      }
      if (url.endsWith("/get_knowledge_list")) {
        return Response.json({ code: 0, data: { knowledge_list: [{ media_id: "folder_202610", title: "202610" }], is_end: true, next_cursor: "" } });
      }
      if (url.endsWith("/check_repeated_names")) return Response.json({ code: 0, data: { results: [{ is_repeated: false }] } });
      if (url.endsWith("/create_media")) {
        return Response.json({
          code: 0,
          data: {
            media_id: "media-1",
            cos_credential: {
              bucket_name: "bucket-1",
              cos_key: "media/file.md",
              expired_time: 2_000_000_000,
              region: "ap-shanghai",
              secret_id: "sid",
              secret_key: "skey",
              start_time: 1_700_000_000,
              token: "token",
            },
          },
        });
      }
      if (url.includes("myqcloud.com")) return new Response(null, { status: 200 });
      if (url.endsWith("/add_knowledge")) return Response.json({ code: 0, data: {} });
      return new Response("unexpected", { status: 500 });
    };
    const tags = await generateSmartTags({ apiKey: "glm", content: "一段足够长的笔记", fetcher });
    assert.deepEqual(tags, ["读书笔记", "时间管理", "效率工具"]);
    await deliverJianguoyun({ content: new TextEncoder().encode("file"), fetcher, password: "pw", remoteName: "note.txt", user: "me" });
    await notifyTelegram(fetcher, "bot", "1", formatCollectionNotification({ collected: 2, published: 1, source: "dida" }));
    assert.match(calls.find((call) => call.includes("sendMessage")) ?? "", /sendMessage/);
    const mirrored = await mirrorToIma({
      apiKey: "key",
      clientId: "client",
      content: renderImaMarkdownCopy("---\ntitle: \"标题\"\nsource_url: \"https://example.com/a\"\n---\n正文"),
      fetcher,
      filename: "20261021-标题.md",
      knowledgeBaseName: "收件",
      sourceUrl: "https://example.com/a",
    });
    assert.equal(mirrored, "mirrored");
    assert.ok(calls.some((call) => call.startsWith("PUT https://bucket-1.cos.ap-shanghai.myqcloud.com/")));
  });

  test("SMTP 隐式 TLS 能把通知交给本机测试服务器", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-smtp-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
    const received: string[] = [];
    const server = createServer({ cert: readFileSync(join(dir, "cert.pem")), key: readFileSync(join(dir, "key.pem")) }, (socket) => {
      socket.write("220 localhost ESMTP\r\n");
      let mode: "command" | "data" = "command";
      let authStep = 0;
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (mode === "data") {
          if (!buffer.includes("\r\n.\r\n")) return;
          received.push(buffer);
          socket.write("250 queued\r\n");
          mode = "command";
          buffer = "";
          return;
        }
        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const command = line.toUpperCase();
          if (command.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH LOGIN\r\n");
          else if (command.startsWith("AUTH")) socket.write("334 VXNlcm5hbWU6\r\n");
          else if (command === "DATA") {
            socket.write("354 go\r\n");
            mode = "data";
          } else if (command.startsWith("MAIL") || command.startsWith("RCPT")) socket.write("250 ok\r\n");
          else if (command === "QUIT") socket.write("221 bye\r\n");
          else {
            authStep += 1;
            socket.write(authStep === 1 ? "334 UGFzc3dvcmQ6\r\n" : "235 authenticated\r\n");
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      await sendSmtpMail({
        body: "同步完成",
        ca: readFileSync(join(dir, "cert.pem"), "utf8"),
        from: "from@example.com",
        host: "127.0.0.1",
        password: "secret",
        port: address.port,
        recipient: "to@example.com",
        subject: "收件箱",
        user: "from@example.com",
      });
    } finally {
      server.close();
    }
    const payload = received.join("\n");
    assert.match(payload, /5ZCM5q2l5a6M5oiQ/);
    assert.equal(Buffer.from("5ZCM5q2l5a6M5oiQ", "base64").toString("utf8"), "同步完成");
    assert.match(buildMimeMessage({ body: "你好", from: "a@b.c", recipient: "d@e.f", subject: "题" }), /Subject: =\?UTF-8\?B\?/);
  });

  test("引擎把知乎 API 正文、智能标签和坚果云效果接进同一条流水线", async () => {
    const { dir, store } = tempStore();
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/api/v4/answers/")) {
        return Response.json({ content: `<p>${"知乎正文".repeat(80)}</p>`, question: { title: "知乎问题" } });
      }
      if (url.includes("bigmodel.cn")) return Response.json({ choices: [{ message: { content: "本地笔记,收件箱,归档" } }] });
      if (url.includes("flomo.example")) return Response.json({ code: 0 });
      if (url.includes("/dav/")) return new Response(null, { status: 204 });
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    };
    const engine = new InboxEngine(store, dir, { fetchImpl, playwrightFetch: null });
    writeProfile(join(dir, "profiles", "zhihu.json"), credentialToStorageState("zhihu", { z_c0: "cookie" }));
    const settings = store.settings();
    settings.llm.apiKey = "glm";
    settings.forward.flomoWebhook = "https://flomo.example/hook";
    settings.jianguoyun = { enabled: true, user: "me", password: "pw", baseUrl: "https://dav.example/dav" };
    store.saveSettings(settings);
    const note = await engine.capture({ itemKind: "text", content: "今天把收件匣接到本机，包含标签和归档。" });
    assert.equal(note.status, "done");
    const noteFile = store.listItems().find((item) => item.itemKind === "text");
    assert.match(readFileSync(noteFile?.destinationPath ?? "", "utf8"), /本地笔记/);
    assert.ok(seen.some((call) => call.startsWith("POST https://flomo.example/hook")));
    const source = join(dir, "clip.txt");
    writeFileSync(source, "clip");
    const file = await engine.capture({ itemKind: "file", localPath: source, remoteName: "clip.txt" });
    assert.equal(file.status, "done");
    assert.ok(seen.some((call) => call === "PUT https://dav.example/dav/clip.txt"));
    const request = resolveZhihuArticleRequest("https://www.zhihu.com/question/3/answer/9");
    assert.ok(request);
    assert.match(buildZhihuDocument({ content: "<p>正文</p>", question: { title: "问题" } }, request), /问题/);
    const article = await engine.capture({ itemKind: "article", url: "https://www.zhihu.com/question/3/answer/9" });
    assert.equal(article.status, "done");
    const archived = store.listArticleEvents()[0];
    assert.match(readFileSync(archived?.filename ?? "", "utf8"), /知乎正文/);
    store.close();
  });
});

describe("真实网络", () => {
  test("example.com 的正文能被抽取", async () => {
    const response = await fetch("https://example.com/");
    assert.equal(response.ok, true);
    const extracted = await extractArticle(await response.text(), "https://example.com/");
    assert.match(`${extracted.title}\n${extracted.markdown}`, /Example Domain/i);
  });

  test("Playwright Chromium 能打开 example.com", async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto("https://example.com/", { timeout: 30_000, waitUntil: "domcontentloaded" });
      assert.match(await page.content(), /Example Domain/i);
    } finally {
      await browser.close();
    }
  });
});

function fakePage(evaluate: PageLike["evaluate"]): PageLike {
  return {
    async close() {},
    evaluate,
    async goto() {},
    url: () => "https://www.inoreader.com/starred",
    async waitForFunction() {},
    async waitForSelector() {},
    async waitForTimeout() {},
  };
}

function contextOf(page: PageLike) {
  return {
    async close() {},
    async newPage() {
      return page;
    },
    async storageState() {
      return { cookies: [], origins: [] };
    },
  };
}
