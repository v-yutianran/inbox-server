import { z } from "zod";

const workerConfigSchema = z.object({
  ARTICLE_REPOSITORY_URL: z.string().url().optional(),
  ARTICLE_TEMPLATE_PATH: z.string().min(1).default("/app/templates/article.md.eta"),
  BROWSER_PROVIDER: z.enum(["local", "cloudflare"]).default("local"),
  BROWSER_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BROWSER_LAUNCH_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  BROWSER_PROXY_URL: z.string().url().optional(),
  CHANNELS_PATH: z.string().min(1).default("/app/channels.yaml"),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  CLOUDFLARE_BROWSER_TOKEN: z.string().min(1).optional(),
  CONTROL_PLANE_URL: z.string().url().optional(),
  DISPLAY: z.string().min(1).optional(),
  EMAIL_NOTIFICATIONS_ENABLED: z.enum(["true", "false"]).default("true"),
  GITHUB_ASKPASS_PATH: z.string().min(1).default("/usr/local/bin/inbox-github-askpass"),
  GITHUB_TOKEN: z.string().min(1).optional(),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  HEALTH_STALE_AFTER_MS: z.coerce.number().int().positive().default(90_000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  IMA_KNOWLEDGE_BASE_NAME: z.string().min(1).optional(),
  IMA_MIRROR_ENABLED: z.enum(["true", "false"]).default("false"),
  IMA_OPENAPI_APIKEY: z.string().min(1).optional(),
  IMA_OPENAPI_CLIENTID: z.string().min(1).optional(),
  IMA_STATE_DIRECTORY: z.string().min(1).optional(),
  IMA_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  IMA_WEB_KNOWLEDGE_BASE_ID: z.string().min(1).optional(),
  IMA_WEB_HEADERS: z.string().transform((value, context) => {
    try { return JSON.parse(value) as unknown; }
    catch {
      context.addIssue({ code: "custom", message: "invalid ima web headers JSON" });
      return z.NEVER;
    }
  }).pipe(z.object({
    cookie: z.string().min(1),
    "x-ima-cookie": z.string().min(1),
    "x-ima-bkn": z.string().min(1),
  })).optional(),
  K_SERVICE: z.string().min(1).optional(),
  OUTBOUND_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).default(40_001),
  OUTBOUND_PROXY_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PERSISTENCE_ROOT: z.string().min(1).default("/data"),
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  QUEUE_VISIBILITY_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(300_000),
  STAGING_DIR: z.string().min(1).optional(),
  TELEGRAM_ATTACHMENT_BUCKET: z.string().min(3).max(63)
    .regex(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/)
    .refine((value) => !value.includes(".."), "invalid GCS bucket name")
    .optional(),
  WORKER_ID: z.string().min(1).optional(),
  WORKER_PROCESSING_ENABLED: z.enum(["true", "false"]).default("false"),
  WORKER_RUN_MODE: z.enum(["loop", "webhook"]).default("loop"),
  WORKER_SERVICE_TOKEN: z.string().min(1).optional(),
  WORKER_WEBHOOK_TOKEN: z.string().min(1).optional(),
  WARP_SOCKS_PROXY_URL: z.string().url().refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "socks5:" && Boolean(parsed.hostname) && Boolean(parsed.port);
  }, "WARP_SOCKS_PROXY_URL must use socks5://host:port").optional(),
}).superRefine((value, context) => {
  if (value.BROWSER_PROVIDER === "cloudflare") {
    if (value.WORKER_RUN_MODE !== "webhook") {
      context.addIssue({
        code: "custom",
        message: "BROWSER_PROVIDER=cloudflare requires WORKER_RUN_MODE=webhook",
        path: ["WORKER_RUN_MODE"],
      });
    }
    for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_BROWSER_TOKEN"] as const) {
      if (!value[key]) {
        context.addIssue({ code: "custom", message: `${key} is required`, path: [key] });
      }
    }
    if (value.BROWSER_PROXY_URL) {
      context.addIssue({
        code: "custom",
        message: "BROWSER_PROXY_URL is only supported for local browser",
        path: ["BROWSER_PROXY_URL"],
      });
    }
  } else if (!value.DISPLAY) {
    context.addIssue({ code: "custom", message: "DISPLAY is required for local browser", path: ["DISPLAY"] });
  }
  if (value.WORKER_PROCESSING_ENABLED === "true") {
    for (const key of [
      "CONTROL_PLANE_URL",
      "WORKER_SERVICE_TOKEN",
    ] as const) {
      if (!value[key]) {
        context.addIssue({ code: "custom", message: `${key} is required`, path: [key] });
      }
    }
    if (value.K_SERVICE && !value.TELEGRAM_ATTACHMENT_BUCKET) {
      context.addIssue({
        code: "custom",
        message: "TELEGRAM_ATTACHMENT_BUCKET is required for Cloud Run workers",
        path: ["TELEGRAM_ATTACHMENT_BUCKET"],
      });
    }
  }
  if (value.WORKER_RUN_MODE === "webhook") {
    if (value.WORKER_PROCESSING_ENABLED !== "true") {
      context.addIssue({
        code: "custom",
        message: "WORKER_PROCESSING_ENABLED must be true in webhook mode",
        path: ["WORKER_PROCESSING_ENABLED"],
      });
    }
    if (!value.WORKER_WEBHOOK_TOKEN) {
      context.addIssue({
        code: "custom",
        message: "WORKER_WEBHOOK_TOKEN is required in webhook mode",
        path: ["WORKER_WEBHOOK_TOKEN"],
      });
    }
    if (value.WORKER_WEBHOOK_TOKEN === value.WORKER_SERVICE_TOKEN) {
      context.addIssue({
        code: "custom",
        message: "WORKER_WEBHOOK_TOKEN must be independent from WORKER_SERVICE_TOKEN",
        path: ["WORKER_WEBHOOK_TOKEN"],
      });
    }
  }
  if (value.IMA_MIRROR_ENABLED === "true") {
    for (const key of [
      "IMA_KNOWLEDGE_BASE_NAME",
      "IMA_OPENAPI_APIKEY",
      "IMA_OPENAPI_CLIENTID",
    ] as const) {
      if (!value[key]) {
        context.addIssue({ code: "custom", message: `${key} is required`, path: [key] });
      }
    }
  }
});

export interface WorkerConfig {
  readonly articleRepositoryUrl: string | undefined;
  readonly articleTemplatePath: string;
  readonly browserProvider: "cloudflare" | "local";
  readonly browserConnectTimeoutMs: number;
  readonly browserLaunchTimeoutMs: number;
  readonly browserProxyUrl: string | undefined;
  readonly channelsPath: string;
  readonly cloudflareAccountId: string | undefined;
  readonly cloudflareBrowserToken: string | undefined;
  readonly controlPlaneUrl: string | undefined;
  readonly display: string | undefined;
  readonly emailNotificationsEnabled: boolean;
  readonly githubAskpassPath: string;
  readonly githubToken: string | undefined;
  readonly healthPort: number;
  readonly healthStaleAfterMs: number;
  readonly heartbeatIntervalMs: number;
  readonly imaApiKey: string | undefined;
  readonly imaClientId: string | undefined;
  readonly imaKnowledgeBaseName: string | undefined;
  readonly imaMirrorEnabled: boolean;
  readonly imaStateDirectory: string;
  readonly imaTimeoutMs: number;
  readonly imaWebHeaders: Readonly<Record<string, string>> | undefined;
  readonly imaWebKnowledgeBaseId: string | undefined;
  readonly outboundProxyPort: number;
  readonly outboundProxyReadyTimeoutMs: number;
  readonly persistenceRoot: string;
  readonly processingEnabled: boolean;
  readonly queueBatchSize: number;
  readonly queuePollIntervalMs: number;
  readonly runMode: "loop" | "webhook";
  readonly stagingDir: string;
  readonly telegramAttachmentBucket: string | undefined;
  readonly visibilityTimeoutMs: number;
  readonly workerId: string;
  readonly workerWebhookToken: string | undefined;
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
    browserProvider: parsed.BROWSER_PROVIDER,
    browserConnectTimeoutMs: parsed.BROWSER_CONNECT_TIMEOUT_MS,
    browserLaunchTimeoutMs: parsed.BROWSER_LAUNCH_TIMEOUT_MS,
    browserProxyUrl: parsed.BROWSER_PROXY_URL,
    channelsPath: parsed.CHANNELS_PATH,
    cloudflareAccountId: parsed.CLOUDFLARE_ACCOUNT_ID,
    cloudflareBrowserToken: parsed.CLOUDFLARE_BROWSER_TOKEN,
    controlPlaneUrl: parsed.CONTROL_PLANE_URL,
    display: parsed.DISPLAY,
    emailNotificationsEnabled: parsed.EMAIL_NOTIFICATIONS_ENABLED === "true",
    githubAskpassPath: parsed.GITHUB_ASKPASS_PATH,
    githubToken: parsed.GITHUB_TOKEN,
    healthPort: parsed.WORKER_RUN_MODE === "webhook"
      ? parsed.PORT ?? parsed.HEALTH_PORT
      : parsed.HEALTH_PORT,
    healthStaleAfterMs: parsed.HEALTH_STALE_AFTER_MS,
    heartbeatIntervalMs: parsed.HEARTBEAT_INTERVAL_MS,
    imaApiKey: parsed.IMA_OPENAPI_APIKEY,
    imaClientId: parsed.IMA_OPENAPI_CLIENTID,
    imaKnowledgeBaseName: parsed.IMA_KNOWLEDGE_BASE_NAME,
    imaMirrorEnabled: parsed.IMA_MIRROR_ENABLED === "true",
    imaStateDirectory: parsed.IMA_STATE_DIRECTORY ?? `${parsed.PERSISTENCE_ROOT}/ima-mirror`,
    imaTimeoutMs: parsed.IMA_TIMEOUT_MS,
    imaWebHeaders: parsed.IMA_WEB_HEADERS,
    imaWebKnowledgeBaseId: parsed.IMA_WEB_KNOWLEDGE_BASE_ID,
    outboundProxyPort: parsed.OUTBOUND_PROXY_PORT,
    outboundProxyReadyTimeoutMs: parsed.OUTBOUND_PROXY_READY_TIMEOUT_MS,
    persistenceRoot: parsed.PERSISTENCE_ROOT,
    processingEnabled: parsed.WORKER_PROCESSING_ENABLED === "true",
    queueBatchSize: parsed.QUEUE_BATCH_SIZE,
    queuePollIntervalMs: parsed.QUEUE_POLL_INTERVAL_MS,
    runMode: parsed.WORKER_RUN_MODE,
    stagingDir: parsed.STAGING_DIR ?? `${parsed.PERSISTENCE_ROOT}/staging`,
    telegramAttachmentBucket: parsed.TELEGRAM_ATTACHMENT_BUCKET,
    visibilityTimeoutMs: parsed.QUEUE_VISIBILITY_TIMEOUT_MS,
    workerId: parsed.WORKER_ID ?? environment.HOSTNAME ?? "inbox-worker",
    workerWebhookToken: parsed.WORKER_WEBHOOK_TOKEN,
    workerServiceToken: parsed.WORKER_SERVICE_TOKEN,
    warpSocksProxyUrl: parsed.WARP_SOCKS_PROXY_URL,
  };
}
