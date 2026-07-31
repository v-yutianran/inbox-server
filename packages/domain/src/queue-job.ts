import { z } from "zod";

export const sourceNames = [
  "telegram",
  "dida",
  "github_stars",
  "zhihu",
  "bilibili",
  "bilibili_toview",
  "inoreader",
  "youtube",
  "x_bookmarks",
  "x_likes",
] as const;

const sourceNameSchema = z.enum(sourceNames);
const triggeredBySchema = z.enum(["schedule", "manual", "shadow"]);
const tagsSchema = z.array(z.string().min(1));

const linkItemSchema = z
  .object({
    itemKind: z.literal("link"),
    tags: tagsSchema.optional(),
    title: z.string().optional(),
    url: z.string().url(),
  })
  .strict();

const textItemSchema = z
  .object({
    content: z.string().min(1),
    itemKind: z.literal("text"),
    tags: tagsSchema.optional(),
  })
  .strict();

const fileItemSchema = z
  .object({
    itemKind: z.literal("file"),
    localPath: z.string().min(1),
    remoteName: z.string().min(1),
  })
  .strict();

const articleItemSchema = z
  .object({
    itemKind: z.literal("article"),
    requestedAt: z.string().datetime({ offset: true }),
    tags: tagsSchema.optional(),
    title: z.string().optional(),
    url: z.string().url(),
  })
  .strict();

export const dispatchItemSchema = z.discriminatedUnion("itemKind", [
  linkItemSchema,
  textItemSchema,
  fileItemSchema,
  articleItemSchema,
]);

const jobEnvelopeShape = {
  createdAt: z.string().datetime({ offset: true }),
  dedupeKey: z.string().min(1),
  jobId: z.string().uuid(),
  schemaVersion: z.literal(1),
} as const;

const collectSourceJobSchema = z
  .object({
    ...jobEnvelopeShape,
    kind: z.literal("collect-source"),
    payload: z
      .object({
        shadow: z.boolean(),
        source: sourceNameSchema,
        triggeredBy: triggeredBySchema,
      })
      .strict(),
  })
  .strict();

const dispatchItemJobSchema = z
  .object({
    ...jobEnvelopeShape,
    kind: z.literal("dispatch-item"),
    payload: dispatchItemSchema,
  })
  .strict();

export const queueJobSchema = z.discriminatedUnion("kind", [
  collectSourceJobSchema,
  dispatchItemJobSchema,
]);

export type DispatchItem = z.infer<typeof dispatchItemSchema>;
export type QueueJob = z.infer<typeof queueJobSchema>;
export type SourceName = z.infer<typeof sourceNameSchema>;

/** 解析不可信队列输入，并在边界拒绝未知版本或无效状态。 */
export function parseQueueJob(input: unknown): QueueJob {
  return queueJobSchema.parse(input);
}

/** 生成不暴露原始 URL、正文或文件名的稳定分发幂等键。 */
export async function createItemDedupeKey(item: DispatchItem): Promise<string> {
  const identity = itemIdentity(item);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity),
  );
  const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `dispatch:${item.itemKind}:${fingerprint}`;
}

function itemIdentity(item: DispatchItem): string {
  switch (item.itemKind) {
    case "link":
    case "article":
      return item.url;
    case "text":
      return item.content;
    case "file":
      return item.remoteName;
  }
}
