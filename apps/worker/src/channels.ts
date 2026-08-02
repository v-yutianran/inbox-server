import { readFile } from "node:fs/promises";

import { parse } from "yaml";
import { z } from "zod";

const configRecordSchema = z.record(z.string(), z.unknown()).default({});
const sourceSchema = z
  .object({
    config: configRecordSchema,
    credential_ref: z.string().optional(),
    enabled: z.boolean().default(false),
    kind: z.string().default("api"),
  })
  .passthrough();
const destinationSchema = z
  .object({
    config: configRecordSchema,
    enabled: z.boolean().default(false),
    item_kind: z.enum(["link", "text", "file", "article"]),
  })
  .passthrough();
const archiveSchema = z
  .object({
    articles_dir: z.string().default("references/article"),
    browser_timeout_seconds: z.number().positive().default(45),
    daily_limit: z.number().int().positive().default(10_000),
    defuddle_timeout_seconds: z.number().positive().default(30),
    enabled: z.boolean().default(false),
    http_timeout_seconds: z.number().positive().default(30),
    interval_seconds: z.number().positive().default(5),
    max_html_bytes: z.number().int().positive().default(8_000_000),
    max_output_bytes: z.number().int().positive().default(10_000_000),
    min_visible_characters: z.number().int().nonnegative().default(200),
    rate_window_count: z.number().int().positive().default(60),
    rate_window_seconds: z.number().int().positive().default(3_600),
    repository_dir: z.string().default("/data/archive/repository"),
  })
  .prefault({});

const channelsSchema = z.object({
  article_archive: archiveSchema,
  credentials: z.record(z.string(), z.unknown()).default({}),
  destinations: z.record(z.string(), destinationSchema).default({}),
  llm: z.record(z.string(), z.unknown()).default({}),
  notification: z.record(z.string(), z.unknown()).default({}),
  sources: z.record(z.string(), sourceSchema).default({}),
});

export type Channels = z.infer<typeof channelsSchema>;

export async function loadChannels(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Channels> {
  const document: unknown = parse(await readFile(path, "utf8"));
  return channelsSchema.parse(interpolateEnvironment(document, environment));
}

/** 管理 API 仅暴露引用名和启用状态，任何 config 值都不会跨安全边界。 */
export function safeChannelSummary(channels: Channels): {
  readonly destinations: Record<string, JsonRecord>;
  readonly sources: Record<string, JsonRecord>;
} {
  return {
    destinations: Object.fromEntries(
      Object.entries(channels.destinations).map(([name, entry]) => [
        name,
        { enabled: entry.enabled, item_kind: entry.item_kind },
      ]),
    ),
    sources: Object.fromEntries(
      Object.entries(channels.sources).map(([name, entry]) => [
        name,
        {
          credential_name:
            readOptionalString(entry.config, "credential_name") ??
            entry.credential_ref ??
            null,
          enabled: entry.enabled,
          kind: entry.kind,
        },
      ]),
    ),
  };
}

type JsonRecord = Readonly<Record<string, unknown>>;

function interpolateEnvironment(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = environment[name];
      if (replacement === undefined || replacement === "") {
        throw new Error(`required environment variable is missing: ${name}`);
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvironment(item, environment));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolateEnvironment(item, environment),
      ]),
    );
  }
  return value;
}

export function readOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
