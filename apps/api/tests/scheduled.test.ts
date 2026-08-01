import { describe, expect, it, vi } from "vitest";

import type { ApiBindings } from "../src/auth";
import { publishScheduledCollection } from "../src/index";
import type { OperationsService } from "../src/operations";

describe("Cron Trigger", () => {
  function createService(): OperationsService {
    const requestScheduledSync = vi.fn().mockResolvedValue({ results: {}, status: "ok" });
    return {
      getOverview: vi.fn(),
      listArticleEvents: vi.fn(),
      listSyncJobs: vi.fn(),
      replaceSnapshot: vi.fn(),
      requestManualSync: vi.fn(),
      requestScheduledSync,
    } satisfies OperationsService;
  }

  it("默认不发布计划任务，避免消费者未就绪时堆积 Queue", async () => {
    const service = createService();

    await publishScheduledCollection({ SCHEDULE_ENABLED: "false" } as ApiBindings, () => service);

    expect(service.requestScheduledSync).not.toHaveBeenCalled();
  });

  it("显式启用后只发布到期收集任务，不在请求内执行浏览器来源", async () => {
    const service = createService();

    await publishScheduledCollection({ SCHEDULE_ENABLED: "true" } as ApiBindings, () => service);

    expect(service.requestScheduledSync).toHaveBeenCalledOnce();
  });
});
