import type { DispatchItem, SourceName } from "@inbox/domain";
import type { Browser } from "playwright";

import type { Channels } from "./channels.js";
import type { WorkerControlPlane } from "./worker-control-plane.js";

export interface AttachmentObjectStore {
  download(objectKey: string): Promise<Uint8Array>;
  upload(objectKey: string, bytes: Uint8Array): Promise<void>;
}

export interface CollectorDependencies {
  readonly attachmentStore?: AttachmentObjectStore;
  readonly browser: Browser;
  readonly channels: Channels;
  readonly controlPlane: WorkerControlPlane;
  readonly fetcher?: typeof fetch;
  readonly stagingDir: string;
}

export interface CollectionResult {
  readonly afterCommit?: () => Promise<void>;
  readonly items: readonly DispatchItem[];
  readonly loginSession?: {
    readonly expiresAt: string;
    readonly platform: string;
    readonly state: unknown;
    readonly status: string;
  };
  readonly meta: Readonly<Record<string, unknown>>;
  readonly source: SourceName;
  readonly stateUpdates: readonly { readonly key: string; readonly value: unknown }[];
}
