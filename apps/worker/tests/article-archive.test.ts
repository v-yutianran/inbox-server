import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import type { Browser } from "playwright";
import { describe, expect, it, vi } from "vitest";

import {
  buildArchiveFilename,
  buildInitialCloneArgs,
  directGitProxyEnvironment,
  extractArticle,
  fetchZhihuArticle,
  gitCommandAttempts,
  gitCommandTimeoutMs,
  GitArticleRepository,
  renderArticleMarkdown,
} from "../src/article-archive";

const template = `---
title: <%~ it.title_yaml %>
source_url: <%~ it.source_url_yaml %>
archived_at: <%~ it.archived_at_yaml %>
author: <%~ it.author_yaml %>
published_at: <%~ it.published_at_yaml %>
tags: <%~ it.tags_yaml %>
---

<%~ it.markdown %>
`;

describe("article archive", () => {
  it("使用 Defuddle 提取正文并由 Eta 渲染稳定 frontmatter", async () => {
    const article = await extractArticle(
      "https://example.com/article",
      "<html><head><title>文章标题</title></head><body><article><h1>文章标题</h1><p>这是足够长的正文内容。</p></article></body></html>",
    );
    const markdown = renderArticleMarkdown(template, {
      archivedAt: "2026-08-01T04:00:00.000Z",
      article,
      sourceUrl: "https://example.com/article",
      tags: ["阅读"],
    });

    expect(article.title).toContain("文章标题");
    expect(markdown).toContain('source_url: "https://example.com/article"');
    expect(markdown).toContain('tags: ["阅读"]');
    expect(markdown).toContain("正文内容");
  });

  it("知乎回答通过登录态上下文调用内容 API", async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({
        body: JSON.stringify({
          content: "<p>这是通过知乎 API 返回的正文。</p>",
          question: { title: "知乎 API 标题" },
        }),
        status: 200,
      }),
      goto: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      addCookies: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
    } as unknown as Browser;

    const article = await fetchZhihuArticle(
      browser,
      { z_c0: "test-cookie" },
      "https://www.zhihu.com/question/2000633021766866030/answer/2065845575841593037",
      30,
      8_000_000,
    );

    expect(context.addCookies).toHaveBeenCalledWith([
      expect.objectContaining({ name: "z_c0", value: "test-cookie" }),
    ]);
    expect(page.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      "/api/v4/answers/2065845575841593037?include=content,excerpt,question,author,created_time",
    );
    expect(article.title).toBe("知乎 API 标题");
    expect(article.markdown).toContain("通过知乎 API 返回的正文");
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("文件名按 Asia/Shanghai 日期生成并移除路径字符", () => {
    expect(
      buildArchiveFilename(
        "标题 / 路径: 测试",
        new Date("2026-07-31T16:30:00.000Z"),
      ),
    ).toBe("20260801-标题-路径-测试.md");
  });

  it("首次初始化仓库使用浅克隆减少 WARP 出口传输量", () => {
    expect(
      buildInitialCloneArgs({
        branch: "main",
        repositoryDir: "/data/article-repository",
        repositoryUrl: "https://github.com/example/archive.git",
      }),
    ).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "--single-branch",
      "https://github.com/example/archive.git",
      "/data/article-repository",
    ]);
  });

  it("Git 网络操作为 WARP 链路预留三分钟超时", () => {
    expect(gitCommandTimeoutMs("ls-remote")).toBe(180_000);
    expect(gitCommandTimeoutMs("pull")).toBe(180_000);
    expect(gitCommandTimeoutMs("push")).toBe(180_000);
    expect(gitCommandTimeoutMs("commit")).toBe(30_000);
  });

  it("Git 远端操作瞬时失败时最多重试三次", () => {
    expect(gitCommandAttempts("ls-remote")).toBe(3);
    expect(gitCommandAttempts("pull")).toBe(3);
    expect(gitCommandAttempts("push")).toBe(3);
    expect(gitCommandAttempts("commit")).toBe(1);
  });

  it("Git 子进程绕过 WARP 代理以兼容 pack 传输", () => {
    expect(directGitProxyEnvironment()).toEqual({
      ALL_PROXY: "",
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      all_proxy: "",
      http_proxy: "",
      https_proxy: "",
    });
  });

  it("已有仓库与远端 HEAD 一致时不下载冗余对象", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-article-git-current-"));
    const binDirectory = join(directory, "bin");
    const gitLog = join(directory, "git.log");
    const repositoryDirectory = join(directory, "repository");
    const fakeGit = join(binDirectory, "git");
    const previousPath = process.env.PATH;
    const previousGitLog = process.env.GIT_LOG;
    await mkdir(join(repositoryDirectory, ".git"), { recursive: true });
    await mkdir(binDirectory);
    await writeFile(
      fakeGit,
      `#!/bin/sh
printf '%s\n' "$*" >> "$GIT_LOG"
case " $* " in
  *" rev-parse HEAD "*) printf '%s\n' '0123456789abcdef' ;;
  *" ls-remote --heads origin main "*) printf '%s\t%s\n' '0123456789abcdef' 'refs/heads/main' ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDirectory}${delimiter}${previousPath ?? ""}`;
    process.env.GIT_LOG = gitLog;

    try {
      const repository = new GitArticleRepository({
        articlesDir: "references/article",
        askpassPath: "/bin/true",
        githubToken: "test-token",
        repositoryDir: repositoryDirectory,
        repositoryUrl: "https://github.com/example/archive.git",
      });
      await repository.save({
        content: '---\nsource_url: "https://example.com/current"\n---\n\n正文',
        filename: "20260801-current.md",
        sourceUrl: "https://example.com/current",
      });

      const commands = (await readFile(gitLog, "utf8")).trim().split("\n");
      expect(commands.some((command) => command.includes(" ls-remote "))).toBe(true);
      expect(commands.some((command) => command.includes(" pull "))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      if (previousGitLog === undefined) delete process.env.GIT_LOG;
      else process.env.GIT_LOG = previousGitLog;
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("已有文章对应本地提交领先远端时继续补推", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-article-git-retry-"));
    const binDirectory = join(directory, "bin");
    const gitLog = join(directory, "git.log");
    const repositoryDirectory = join(directory, "repository");
    const articlesDirectory = join(repositoryDirectory, "references/article");
    const fakeGit = join(binDirectory, "git");
    const previousPath = process.env.PATH;
    const previousGitLog = process.env.GIT_LOG;
    await mkdir(join(repositoryDirectory, ".git"), { recursive: true });
    await mkdir(articlesDirectory, { recursive: true });
    await writeFile(
      join(articlesDirectory, "20260802-retry.md"),
      '---\nsource_url: "https://example.com/retry"\n---\n\n正文',
    );
    await mkdir(binDirectory);
    await writeFile(
      fakeGit,
      `#!/bin/sh
printf '%s\n' "$*" >> "$GIT_LOG"
case " $* " in
  *" rev-parse HEAD "*) printf '%s\n' 'local-head' ;;
  *" ls-remote --heads origin main "*) printf '%s\t%s\n' 'remote-head' 'refs/heads/main' ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDirectory}${delimiter}${previousPath ?? ""}`;
    process.env.GIT_LOG = gitLog;

    try {
      const repository = new GitArticleRepository({
        articlesDir: "references/article",
        askpassPath: "/bin/true",
        githubToken: "test-token",
        repositoryDir: repositoryDirectory,
        repositoryUrl: "https://github.com/example/archive.git",
      });
      const result = await repository.save({
        content: '---\nsource_url: "https://example.com/retry"\n---\n\n正文',
        filename: "20260802-retry.md",
        sourceUrl: "https://example.com/retry",
      });

      const commands = (await readFile(gitLog, "utf8")).trim().split("\n");
      expect(result.created).toBe(false);
      expect(commands.some((command) => command.includes(" pull "))).toBe(true);
      expect(commands.some((command) => command.includes(" push "))).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      if (previousGitLog === undefined) delete process.env.GIT_LOG;
      else process.env.GIT_LOG = previousGitLog;
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("不完整仓库先保留副本再重新浅克隆", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-article-git-incomplete-"));
    const binDirectory = join(directory, "bin");
    const gitLog = join(directory, "git.log");
    const repositoryDirectory = join(directory, "repository");
    const fakeGit = join(binDirectory, "git");
    const previousPath = process.env.PATH;
    const previousGitLog = process.env.GIT_LOG;
    await mkdir(join(repositoryDirectory, ".git"), { recursive: true });
    await writeFile(join(repositoryDirectory, "partial-clone"), "保留");
    await mkdir(binDirectory);
    await writeFile(
      fakeGit,
      `#!/bin/sh
printf '%s\n' "$*" >> "$GIT_LOG"
case " $* " in
  *" rev-parse --verify HEAD "*) exit 1 ;;
esac
if [ "$1" = "clone" ]; then
  for last_argument do :; done
  mkdir -p "$last_argument/.git"
fi
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDirectory}${delimiter}${previousPath ?? ""}`;
    process.env.GIT_LOG = gitLog;

    try {
      const repository = new GitArticleRepository({
        articlesDir: "references/article",
        askpassPath: "/bin/true",
        githubToken: "test-token",
        repositoryDir: repositoryDirectory,
        repositoryUrl: "https://github.com/example/archive.git",
      });
      await repository.save({
        content: '---\nsource_url: "https://example.com/recovered"\n---\n\n正文',
        filename: "20260801-recovered.md",
        sourceUrl: "https://example.com/recovered",
      });

      const commands = (await readFile(gitLog, "utf8")).trim().split("\n");
      const entries = await readdir(directory);
      expect(commands.some((command) => command.startsWith("clone --depth 1"))).toBe(true);
      expect(entries.some((entry) => entry.startsWith("repository.incomplete-"))).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      if (previousGitLog === undefined) delete process.env.GIT_LOG;
      else process.env.GIT_LOG = previousGitLog;
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("首次浅克隆已得到最新分支时不重复 pull", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inbox-article-git-"));
    const binDirectory = join(directory, "bin");
    const gitLog = join(directory, "git.log");
    const repositoryDirectory = join(directory, "repository");
    const fakeGit = join(binDirectory, "git");
    const previousPath = process.env.PATH;
    const previousGitLog = process.env.GIT_LOG;
    await mkdir(binDirectory);
    await writeFile(
      fakeGit,
      `#!/bin/sh
printf '%s\n' "$*" >> "$GIT_LOG"
if [ "$1" = "clone" ]; then
  for last_argument do :; done
  mkdir -p "$last_argument/.git"
fi
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDirectory}${delimiter}${previousPath ?? ""}`;
    process.env.GIT_LOG = gitLog;

    try {
      const repository = new GitArticleRepository({
        articlesDir: "references/article",
        askpassPath: "/bin/true",
        githubToken: "test-token",
        repositoryDir: repositoryDirectory,
        repositoryUrl: "https://github.com/example/archive.git",
      });
      await repository.save({
        content: '---\nsource_url: "https://example.com/article"\n---\n\n正文',
        filename: "20260801-article.md",
        sourceUrl: "https://example.com/article",
      });

      const commands = (await readFile(gitLog, "utf8")).trim().split("\n");
      expect(commands[0]).toContain("clone --depth 1");
      expect(commands.some((command) => command.includes(" pull "))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      if (previousGitLog === undefined) delete process.env.GIT_LOG;
      else process.env.GIT_LOG = previousGitLog;
      await rm(directory, { force: true, recursive: true });
    }
  });
});
