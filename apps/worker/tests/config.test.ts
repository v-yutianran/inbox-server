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
    expect(config.browserLaunchTimeoutMs).toBe(900_000);
    expect(config.channelsPath).toBe("/app/channels.yaml");
    expect(config.persistenceRoot).toBe("/data");
    expect(config.imaMirrorEnabled).toBe(false);
    expect(config.imaStateDirectory).toBe("/data/ima-mirror");
    expect(config.warpSocksProxyUrl).toBeUndefined();
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
      PERSISTENCE_ROOT: "/data",
    });

    expect(config.imaMirrorEnabled).toBe(true);
    expect(config.imaKnowledgeBaseName).toBe("天然的知识库");
    expect(config.imaTimeoutMs).toBe(45_000);
    expect(config.imaStateDirectory).toBe("/data/ima-mirror");
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
});
