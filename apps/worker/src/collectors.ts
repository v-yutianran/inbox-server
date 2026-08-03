import type { SourceName } from "@inbox/domain";

import { collectBrowserSource } from "./browser-collectors.js";
import type { CollectionResult, CollectorDependencies } from "./collector-types.js";
import { collectHttpSource } from "./http-collectors.js";

export async function collectSource(
  source: SourceName,
  dependencies: CollectorDependencies,
): Promise<CollectionResult> {
  return source === "telegram" || source === "dida" || source === "github_stars"
    ? collectHttpSource(source, dependencies)
    : collectBrowserSource(source, dependencies);
}

export type { CollectionResult, CollectorDependencies } from "./collector-types.js";
