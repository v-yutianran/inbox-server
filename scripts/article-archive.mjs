#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Defuddle } from "defuddle/node";
import { Eta } from "eta";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = await readFile(path.join(ROOT, "templates/article.md.eta"), "utf8");
const eta = new Eta({ autoEscape: false, autoTrim: false });

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function parseArticle(request) {
  if (typeof request.url !== "string" || typeof request.html !== "string") {
    throw new Error("invalid_parse_request");
  }
  const result = await Defuddle(request.html, request.url, { markdown: true });
  return {
    ok: true,
    article: {
      title: String(result.title ?? "").trim(),
      author: String(result.author ?? "").trim(),
      published_at: String(result.published ?? result.date ?? "").trim(),
      markdown: String(result.contentMarkdown ?? result.content ?? "").trim(),
    },
  };
}

function renderMarkdown(request) {
  const metadata = request.metadata;
  if (!metadata || typeof metadata !== "object" || typeof request.markdown !== "string") {
    throw new Error("invalid_render_request");
  }
  const markdown = eta.renderString(TEMPLATE, {
    title_yaml: yamlScalar(metadata.title),
    source_url_yaml: yamlScalar(metadata.source_url),
    archived_at_yaml: yamlScalar(metadata.archived_at),
    author_yaml: yamlScalar(metadata.author),
    published_at_yaml: yamlScalar(metadata.published_at),
    tags_yaml: JSON.stringify(Array.isArray(metadata.tags) ? metadata.tags : []),
    markdown: request.markdown.trim(),
  });
  return { ok: true, markdown: `${markdown.trim()}\n` };
}

try {
  const request = await readRequest();
  const response = request.action === "parse"
    ? await parseArticle(request)
    : request.action === "render"
      ? renderMarkdown(request)
      : { ok: false, error: "unsupported_action" };
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  const code = error instanceof SyntaxError ? "invalid_json" : "bridge_failed";
  process.stdout.write(JSON.stringify({ ok: false, error: code }));
}
