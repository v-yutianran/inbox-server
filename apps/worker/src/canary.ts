import type { DispatchItem } from "@inbox/domain";

import type { ArticleRepository } from "./article-archive.js";

export type CanaryPath = "direct" | "short_rejected" | "browser_fallback";

export interface CanarySavedEvidence {
  readonly contentBytes: number;
  readonly filename: string;
  readonly sourceFingerprint: string;
}

export function createCanaryArticleItem(input: {
  readonly path: CanaryPath;
  readonly requestedAt: string;
  readonly runId: string;
}): Extract<DispatchItem, { itemKind: "article" }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(input.runId)) {
    throw new Error("invalid canary run id");
  }
  return {
    itemKind: "article",
    requestedAt: input.requestedAt,
    tags: ["canary", `canary:${input.runId}`, `canary-path:${input.path}`],
    title: `synthetic-canary-${input.path}`,
    url: `https://canary.invalid/${input.runId}/${input.path}`,
  };
}

/** 仅保留脱敏摘要；永远不写文件、Git 或真实 destination。 */
export function createDryRunCanaryRepository(): {
  readonly repository: ArticleRepository;
  readonly snapshot: () => {
    readonly externalWriteCount: 0;
    readonly saved: readonly CanarySavedEvidence[];
  };
} {
  const saved: CanarySavedEvidence[] = [];
  return {
    repository: {
      async save(input) {
        saved.push({
          contentBytes: Buffer.byteLength(input.content),
          filename: input.filename,
          sourceFingerprint: await sha256Hex(input.sourceUrl),
        });
        return { created: true, filename: input.filename };
      },
    },
    snapshot: () => ({ externalWriteCount: 0, saved: saved.map((item) => ({ ...item })) }),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
