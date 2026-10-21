import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildArchiveFilename, createItemDedupeKey, visibleCharacters } from "./domain.ts";

export interface ExtractedArticle {
  title: string;
  markdown: string;
}

export async function extractArticle(html: string, url: string): Promise<ExtractedArticle> {
  try {
    const { Defuddle } = await import("defuddle/node");
    const result = await Defuddle(html, url, { markdown: true });
    const title = String(result.title ?? "").trim();
    let markdown = String(result.contentMarkdown ?? result.content ?? "").trim();
    if (title && markdown && !markdown.includes(title)) markdown = `${title}\n\n${markdown}`;
    if (title && markdown) return { title, markdown };
  } catch {
    // Defuddle 解析失败时退回标签剥离，避免一篇文章因为提取器异常整篇失败。
  }
  const fallback = extractHtml(html);
  if (fallback.title && fallback.markdown && !fallback.markdown.includes(fallback.title)) {
    fallback.markdown = `${fallback.title}\n\n${fallback.markdown}`;
  }
  return fallback;
}

export function extractHtml(html: string): ExtractedArticle {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const markdown = decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
  return { title, markdown };
}

export function renderArticleMarkdown(input: {
  archivedAt: string;
  title: string;
  author: string;
  sourceUrl: string;
  tags: readonly string[];
  markdown: string;
}): string {
  return [
    "---",
    `title: ${yamlScalar(input.title)}`,
    `author: ${yamlScalar(input.author)}`,
    `source_url: ${yamlScalar(input.sourceUrl)}`,
    `tags: ${JSON.stringify(input.tags)}`,
    `archived_at: ${yamlScalar(input.archivedAt)}`,
    "---",
    "",
    input.markdown.trim(),
    "",
  ].join("\n");
}

export function writeArticleFile(directory: string, title: string, archivedAt: Date, content: string, url: string): string {
  mkdirSync(directory, { recursive: true });
  const collision = createItemDedupeKey({
    itemKind: "article",
    requestedAt: archivedAt.toISOString(),
    url,
  }).slice(-8);
  let filename = buildArchiveFilename(title, archivedAt);
  const preferred = join(directory, filename);
  if (existsSync(preferred)) {
    const existing = readFileSync(preferred, "utf8");
    if (existing.includes(url)) return preferred;
    filename = buildArchiveFilename(title, archivedAt, collision);
  }
  const path = join(directory, filename);
  if (!existsSync(path)) writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

export function writeTextRecord(directory: string, name: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.md`);
  if (!existsSync(path)) writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

export function copyLocalFile(sourcePath: string, directory: string, remoteName: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, remoteName);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(sourcePath, path);
  }
  return path;
}

export function articleLooksUseful(article: ExtractedArticle, minimum: number): { ok: boolean; reason: string | null; visible: number } {
  const visible = visibleCharacters(article.markdown);
  if (!article.title.trim()) return { ok: false, reason: "missing_title", visible };
  if (visible < minimum) return { ok: false, reason: "short_content", visible };
  return { ok: true, reason: null, visible };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
