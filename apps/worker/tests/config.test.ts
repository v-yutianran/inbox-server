import { describe, expect, it } from "vitest";

import { parseWorkerConfig } from "../src/config";

describe("worker config", () => {
  it("生产模式必须显式提供控制面服务凭据", () => {
    expect(() =>
      parseWorkerConfig({ DISPLAY: ":99", WORKER_PROCESSING_ENABLED: "true" }),
    ).toThrow();
  });

  it("默认关闭消费，允许仅启动 headed Chromium 与健康探针", () => {
    const config = parseWorkerConfig({ DISPLAY: ":99" });

    expect(config.processingEnabled).toBe(false);
    expect(config.browserProvider).toBe("local");
    expect(config.runMode).toBe("loop");
    expect(config.healthPort).toBe(8_080);
    expect(config.emailNotificationsEnabled).toBe(true);
    expect(config.browserConnectTimeoutMs).toBe(30_000);
    expect(config.browserLaunchTimeoutMs).toBe(900_000);
    expect(config.channelsPath).toBe("/app/channels.yaml");
    expect(config.persistenceRoot).toBe("/data");
    expect(config.imaMirrorEnabled).toBe(false);
    expect(config.imaStateDirectory).toBe("/data/ima-mirror");
    expect(config.warpSocksProxyUrl).toBeUndefined();
    expect(config.telegramAttachmentBucket).toBeUndefined();
  });

  it("Cloud Run 消费必须显式指定私有 Telegram 附件 bucket，本地可不配置", () => {
    const cloudRun = {
      BROWSER_PROVIDER: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_BROWSER_TOKEN: "browser-token",
      CONTROL_PLANE_URL: "https://api.example.com",
      K_SERVICE: "inbox-worker",
      PORT: "8080",
      WORKER_PROCESSING_ENABLED: "true",
      WORKER_RUN_MODE: "webhook",
      WORKER_SERVICE_TOKEN: "service-token",
      WORKER_WEBHOOK_TOKEN: "webhook-token",
    };

    expect(() => parseWorkerConfig(cloudRun)).toThrow();
    expect(parseWorkerConfig({
      ...cloudRun,
      TELEGRAM_ATTACHMENT_BUCKET: "inbox-worker-attachments",
    }).telegramAttachmentBucket).toBe("inbox-worker-attachments");
    expect(parseWorkerConfig({ DISPLAY: ":99" }).telegramAttachmentBucket).toBeUndefined();
  });

  it("邮件通知开关可显式关闭", () => {
    expect(parseWorkerConfig({ DISPLAY: ":99", EMAIL_NOTIFICATIONS_ENABLED: "false" })
      .emailNotificationsEnabled).toBe(false);
  });

  it("拒绝非布尔字符串的邮件通知开关", () => {
    expect(() =>
      parseWorkerConfig({ DISPLAY: ":99", EMAIL_NOTIFICATIONS_ENABLED: "yes" }),
    ).toThrow();
  });

  it("启用 ima 镜像时要求完整凭据和知识库名称", () => {
    expect(() => parseWorkerConfig({ DISPLAY: ":99", IMA_MIRROR_ENABLED: "true" })).toThrow();

    const config = parseWorkerConfig({
      DISPLAY: ":99",
      IMA_KNOWLEDGE_BASE_NAME: "天然的知识库",
      IMA_MIRROR_ENABLED: "true",
      IMA_OPENAPI_APIKEY: "api-key",
      IMA_OPENAPI_CLIENTID: "client-id",
      IMA_TIMEOUT_MS: "45000",
      IMA_WEB_HEADERS: JSON.stringify({ cookie: "web-cookie", "x-ima-cookie": "web-session", "x-ima-bkn": "123" }),
      IMA_WEB_KNOWLEDGE_BASE_ID: "web-kb-1",
      PERSISTENCE_ROOT: "/data",
    });

    expect(config.imaMirrorEnabled).toBe(true);
    expect(config.imaKnowledgeBaseName).toBe("天然的知识库");
    expect(config.imaTimeoutMs).toBe(45_000);
    expect(config.imaStateDirectory).toBe("/data/ima-mirror");
    expect(config.imaWebHeaders).toHaveProperty("cookie", "web-cookie");
    expect(config.imaWebKnowledgeBaseId).toBe("web-kb-1");
    expect(() => parseWorkerConfig({ DISPLAY: ":99", IMA_WEB_HEADERS: "invalid JSON" })).toThrow();
  });

  it("完整生产配置解析为固定批量和可见性超时", () => {
    const config = parseWorkerConfig({
      BROWSER_PROXY_URL: "http://127.0.0.1:7897",
      BROWSER_LAUNCH_TIMEOUT_MS: "600000",
      CONTROL_PLANE_URL: "https://api.example.com",
      DISPLAY: ":99",
      WORKER_PROCESSING_ENABLED: "true",
      WORKER_SERVICE_TOKEN: "worker-token",
      WARP_SOCKS_PROXY_URL: "socks5://127.0.0.1:40000",
    });

    expect(config.processingEnabled).toBe(true);
    expect(config.browserProxyUrl).toBe("http://127.0.0.1:7897");
    expect(config.browserLaunchTimeoutMs).toBe(600_000);
    expect(config.queueBatchSize).toBe(10);
    expect(config.visibilityTimeoutMs).toBe(300_000);
    expect(config.warpSocksProxyUrl).toBe("socks5://127.0.0.1:40000");
  });

  it("webhook 模式要求启用处理、控制面凭据和独立触发凭据，并使用 Cloud Run PORT", () => {
    const base = {
      CONTROL_PLANE_URL: "https://api.example.com",
      DISPLAY: ":99",
      WORKER_PROCESSING_ENABLED: "true",
      WORKER_RUN_MODE: "webhook",
      WORKER_SERVICE_TOKEN: "service-token",
    };

    expect(() => parseWorkerConfig(base)).toThrow();
    expect(() => parseWorkerConfig({ ...base, WORKER_WEBHOOK_TOKEN: "" })).toThrow();
    expect(() => parseWorkerConfig({
      ...base,
      WORKER_SERVICE_TOKEN: "same-secret",
      WORKER_WEBHOOK_TOKEN: "same-secret",
    })).toThrow();

    const config = parseWorkerConfig({
      ...base,
      PORT: "9090",
      WORKER_WEBHOOK_TOKEN: "separate-token",
    });
    expect(config.runMode).toBe("webhook");
    expect(config.workerWebhookToken).toBe("separate-token");
    expect(config.healthPort).toBe(9090);

    expect(parseWorkerConfig({ DISPLAY: ":99", PORT: "9090" }).healthPort).toBe(8_080);
  });

  it("webhook 模式不能在处理未启用时启动", () => {
    expect(() => parseWorkerConfig({
      DISPLAY: ":99",
      WORKER_RUN_MODE: "webhook",
      WORKER_WEBHOOK_TOKEN: "trigger-token",
    })).toThrow();
  });

  it("Cloudflare Browser Run 仅允许 webhook，并要求独立连接配置", () => {
    const base = {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CONTROL_PLANE_URL: "https://api.example.com",
      DISPLAY: ":99",
      WORKER_PROCESSING_ENABLED: "true",
      WORKER_RUN_MODE: "webhook",
      WORKER_SERVICE_TOKEN: "service-token",
      WORKER_WEBHOOK_TOKEN: "trigger-token",
      BROWSER_PROVIDER: "cloudflare",
    };

    expect(() => parseWorkerConfig(base)).toThrow(/CLOUDFLARE_BROWSER_TOKEN/);
    expect(() => parseWorkerConfig({
      ...base,
      CLOUDFLARE_ACCOUNT_ID: undefined,
      CLOUDFLARE_BROWSER_TOKEN: "browser-token",
    })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);

    const config = parseWorkerConfig({
      ...base,
      DISPLAY: undefined,
      CLOUDFLARE_BROWSER_TOKEN: "browser-token",
    });
    expect(config.browserProvider).toBe("cloudflare");
    expect(config.cloudflareAccountId).toBe("account-id");
    expect(config.cloudflareBrowserToken).toBe("browser-token");
    expect(config.browserConnectTimeoutMs).toBe(30_000);
    expect(config.display).toBeUndefined();

    expect(parseWorkerConfig({
      ...base,
      BROWSER_CONNECT_TIMEOUT_MS: "45000",
      DISPLAY: undefined,
      CLOUDFLARE_BROWSER_TOKEN: "browser-token",
    }).browserConnectTimeoutMs).toBe(45_000);

    expect(() => parseWorkerConfig({
      ...base,
      BROWSER_PROXY_URL: "http://127.0.0.1:7897",
      DISPLAY: undefined,
      CLOUDFLARE_BROWSER_TOKEN: "browser-token",
    })).toThrow(/BROWSER_PROXY_URL/);

    expect(() => parseWorkerConfig({
      ...base,
      DISPLAY: undefined,
      WORKER_RUN_MODE: "loop",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_BROWSER_TOKEN: "browser-token",
    })).toThrow(/webhook/i);
  });

  it("本地 browser provider 继续要求 DISPLAY", () => {
    expect(() => parseWorkerConfig({})).toThrow();
  });

  it("Cloudflare provider 拒绝仅适用于本地 Chromium 的 BROWSER_PROXY_URL", () => {
    expect(() => parseWorkerConfig({
      BROWSER_PROVIDER: "cloudflare",
      BROWSER_PROXY_URL: "http://127.0.0.1:7897",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_BROWSER_TOKEN: "browser-token",
      CONTROL_PLANE_URL: "https://api.example.com",
      WORKER_PROCESSING_ENABLED: "true",
      WORKER_RUN_MODE: "webhook",
      WORKER_SERVICE_TOKEN: "service-token",
      WORKER_WEBHOOK_TOKEN: "trigger-token",
    })).toThrow(/BROWSER_PROXY_URL/);
  });
});
