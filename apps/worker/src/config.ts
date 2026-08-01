import { z } from "zod";

const workerConfigSchema = z.object({
  ARTICLE_REPOSITORY_URL: z.string().url().optional(),
  ARTICLE_TEMPLATE_PATH: z.string().min(1).default("/app/templates/article.md.eta"),
  CHANNELS_PATH: z.string().min(1).default("/app/channels.yaml"),
  CONTROL_PLANE_URL: z.string().url().optional(),
  DISPLAY: z.string().min(1),
  GITHUB_ASKPASS_PATH: z.string().min(1).default("/usr/local/bin/inbox-github-askpass"),
  GITHUB_TOKEN: z.string().min(1).optional(),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  HEALTH_STALE_AFTER_MS: z.coerce.number().int().positive().default(90_000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  OUTBOUND_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).default(40_001),
  OUTBOUND_PROXY_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PERSISTENCE_ROOT: z.string().min(1).default("/data"),
  QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  QUEUE_VISIBILITY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  STAGING_DIR: z.string().min(1).optional(),
  WORKER_ID: z.string().min(1).optional(),
  WORKER_PROCESSING_ENABLED: z.enum(["true", "false"]).default("false"),
  WORKER_SERVICE_TOKEN: z.string().min(1).optional(),
  WARP_SOCKS_PROXY_URL: z.string().url().refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "socks5:" && Boolean(parsed.hostname) && Boolean(parsed.port);
  }, "WARP_SOCKS_PROXY_URL must use socks5://host:port").optional(),
}).superRefine((value, context) => {
  if (value.WORKER_PROCESSING_ENABLED !== "true") return;
  for (const key of [
    "CONTROL_PLANE_URL",
    "WORKER_SERVICE_TOKEN",
  ] as const) {
    if (!value[key]) {
      context.addIssue({ code: "custom", message: `${key} is required`, path: [key] });
    }
  }
});

export interface WorkerConfig {
  readonly articleRepositoryUrl: string | undefined;
  readonly articleTemplatePath: string;
  readonly channelsPath: string;
  readonly controlPlaneUrl: string | undefined;
  readonly display: string;
  readonly githubAskpassPath: string;
  readonly githubToken: string | undefined;
  readonly healthPort: number;
  readonly healthStaleAfterMs: number;
  readonly heartbeatIntervalMs: number;
  readonly outboundProxyPort: number;
  readonly outboundProxyReadyTimeoutMs: number;
  readonly persistenceRoot: string;
  readonly processingEnabled: boolean;
  readonly queueBatchSize: number;
  readonly queuePollIntervalMs: number;
  readonly stagingDir: string;
  readonly visibilityTimeoutMs: number;
  readonly workerId: string;
  readonly workerServiceToken: string | undefined;
  readonly warpSocksProxyUrl: string | undefined;
}

export function parseWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WorkerConfig {
  const parsed = workerConfigSchema.parse(environment);
  return {
    articleRepositoryUrl: parsed.ARTICLE_REPOSITORY_URL,
    articleTemplatePath: parsed.ARTICLE_TEMPLATE_PATH,
    channelsPath: parsed.CHANNELS_PATH,
    controlPlaneUrl: parsed.CONTROL_PLANE_URL,
    display: parsed.DISPLAY,
    githubAskpassPath: parsed.GITHUB_ASKPASS_PATH,
    githubToken: parsed.GITHUB_TOKEN,
    healthPort: parsed.HEALTH_PORT,
    healthStaleAfterMs: parsed.HEALTH_STALE_AFTER_MS,
    heartbeatIntervalMs: parsed.HEARTBEAT_INTERVAL_MS,
    outboundProxyPort: parsed.OUTBOUND_PROXY_PORT,
    outboundProxyReadyTimeoutMs: parsed.OUTBOUND_PROXY_READY_TIMEOUT_MS,
    persistenceRoot: parsed.PERSISTENCE_ROOT,
    processingEnabled: parsed.WORKER_PROCESSING_ENABLED === "true",
    queueBatchSize: parsed.QUEUE_BATCH_SIZE,
    queuePollIntervalMs: parsed.QUEUE_POLL_INTERVAL_MS,
    stagingDir: parsed.STAGING_DIR ?? `${parsed.PERSISTENCE_ROOT}/staging`,
    visibilityTimeoutMs: parsed.QUEUE_VISIBILITY_TIMEOUT_MS,
    workerId: parsed.WORKER_ID ?? environment.HOSTNAME ?? "inbox-worker",
    workerServiceToken: parsed.WORKER_SERVICE_TOKEN,
    warpSocksProxyUrl: parsed.WARP_SOCKS_PROXY_URL,
  };
}
