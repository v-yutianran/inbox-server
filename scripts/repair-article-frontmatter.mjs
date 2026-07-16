#!/usr/bin/env node

import { readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const FIELDS = [
  ["title", "title: ", "string"],
  ["source_url", "source_url: ", "string"],
  ["archived_at", "archived_at: ", "string"],
  ["author", "author: ", "string"],
  ["published_at", "published_at: ", "string"],
  ["tags", "tags: ", "array"],
];

function takeJsonValue(source, start) {
  const opening = source[start];
  if (opening === '"') {
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return { raw: source.slice(start, index + 1), end: index + 1 };
      }
    }
    throw new Error("unterminated_json_string");
  }

  if (opening === "[") {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
      } else if (character === '"') {
        inString = true;
      } else if (character === "[") {
        depth += 1;
      } else if (character === "]") {
        depth -= 1;
        if (depth === 0) {
          return { raw: source.slice(start, index + 1), end: index + 1 };
        }
      }
    }
    throw new Error("unterminated_json_array");
  }

  throw new Error("unsupported_json_value");
}

function repairDocument(content) {
  if (!content.startsWith("---\n")) {
    return null;
  }
  const lineEnd = content.indexOf("\n", 4);
  if (lineEnd === -1) {
    return null;
  }
  const malformed = content.slice(4, lineEnd);
  if (!malformed.startsWith(FIELDS[0][1])) {
    return null;
  }

  let cursor = FIELDS[0][1].length;
  const firstValue = takeJsonValue(malformed, cursor);
  if (typeof JSON.parse(firstValue.raw) !== "string") {
    throw new Error("invalid_field_type");
  }
  if (!malformed.startsWith(FIELDS[1][1], firstValue.end)) {
    return null;
  }

  const rawValues = [firstValue.raw];
  cursor = firstValue.end;
  for (const [, label, expectedType] of FIELDS.slice(1)) {
    if (!malformed.startsWith(label, cursor)) {
      throw new Error("invalid_field_order");
    }
    cursor += label.length;
    const value = takeJsonValue(malformed, cursor);
    const parsed = JSON.parse(value.raw);
    if (
      (expectedType === "string" && typeof parsed !== "string")
      || (expectedType === "array" && !Array.isArray(parsed))
    ) {
      throw new Error("invalid_field_type");
    }
    rawValues.push(value.raw);
    cursor = value.end;
  }
  if (malformed.slice(cursor) !== "---") {
    throw new Error("invalid_frontmatter_terminator");
  }

  const frontmatter = FIELDS.map(([, label], index) => `${label}${rawValues[index]}`).join("\n");
  return `---\n${frontmatter}\n---\n${content.slice(lineEnd + 1)}`;
}

async function replaceAtomically(filePath, content) {
  const fileStat = await stat(filePath);
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.frontmatter-repair`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: fileStat.mode });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.directory) {
    throw new Error("directory_required");
  }

  const directory = path.resolve(values.directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
  const repairs = [];
  let skipped = 0;

  // 先解析全部文件，任何异常都会在写入前终止，避免产生半完成迁移。
  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const repaired = repairDocument(content);
    if (repaired === null) {
      skipped += 1;
    } else {
      repairs.push({ filePath, repaired });
    }
  }

  if (!values["dry-run"]) {
    for (const repair of repairs) {
      await replaceAtomically(repair.filePath, repair.repaired);
    }
  }

  process.stdout.write(JSON.stringify({
    scanned: files.length,
    repairable: repairs.length,
    repaired: values["dry-run"] ? 0 : repairs.length,
    skipped,
    dry_run: values["dry-run"],
  }));
}

main().catch(() => {
  process.stderr.write("frontmatter_repair_failed\n");
  process.exitCode = 1;
});
