import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { requireApiKey, requireWorkerToken, type ApiBindings } from "./auth.js";
import { isAllowedConsoleOrigin } from "./cors.js";
import {
  createControlPlaneServiceFromBindings,
  MissingCookieFieldError,
  UnsupportedCookiePlatformError,
  type ControlPlaneService,
} from "./control-plane.js";
import {
  createOperationsServiceFromBindings,
  operationsOverviewSchema,
  type OperationsService,
} from "./operations.js";
import {
  createLegacyMigrationServiceFromBindings,
  type LegacyMigrationService,
} from "./legacy-migration.js";
import {
  createQueueInboxServiceFromBindings,
  type QueueInboxService,
} from "./queue-inbox.js";

const inboxPullSchema = z.object({
  batchSize: z.number().int().min(1).max(100),
  visibilityTimeoutMs: z.number().int().min(1_000).max(3_600_000),
});
const inboxSettlementSchema = z.object({
  acks: z.array(z.string().min(1)),
  retries: z.array(
    z.object({
      delaySeconds: z.number().int().min(0).max(43_200).optional(),
      leaseId: z.string().min(1),
    }),
  ),
});
const rateLimitBatchSchema = z.object({
  inputs: z
    .array(
      z.object({
        bucketKey: z.string().min(1),
        limit: z.number().int().positive(),
        scope: z.string().min(1),
        windowSeconds: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(8),
});
const replayDeadLetterSchema = z.object({
  dryRun: z.boolean(),
  idempotencyKey: z.string().min(1).max(128),
});

interface AppOptions {
  readonly createControlPlaneService?: (bindings: ApiBindings) => ControlPlaneService;
  readonly createLegacyMigrationService?: (bindings: ApiBindings) => LegacyMigrationService;
  readonly createOperationsService?: (bindings: ApiBindings) => OperationsService;
  readonly createQueueInboxService?: (bindings: ApiBindings) => QueueInboxService;
}

export function createApp({
  createControlPlaneService = createControlPlaneServiceFromBindings,
  createLegacyMigrationService = createLegacyMigrationServiceFromBindings,
  createOperationsService = createOperationsServiceFromBindings,
  createQueueInboxService = createQueueInboxServiceFromBindings,
}: AppOptions = {}): Hono<{ Bindings: ApiBindings }> {
  const app = new Hono<{ Bindings: ApiBindings }>();

  app.use(
    "*",
    cors({
      allowHeaders: ["Authorization", "Content-Type", "X-API-Key"],
      allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
      maxAge: 86_400,
      origin: (origin, context) =>
        isAllowedConsoleOrigin(origin, context.env?.CONSOLE_ORIGINS) ? origin : undefined,
    }),
  );

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ready" }));

  app.use("/queue", requireApiKey);
  app.use("/queue/*", requireApiKey);
  app.use("/channels", requireApiKey);
  app.use("/login/*", requireApiKey);
  app.get("/queue", async (context) =>
    context.json(await createControlPlaneService(context.env).getQueueSummary()),
  );
  app.get("/queue/dlq", async (context) =>
    context.json(await createControlPlaneService(context.env).getQueueDlq()),
  );
  app.get("/channels", async (context) =>
    context.json(await createControlPlaneService(context.env).getChannels()),
  );
  app.post("/login/:platform/cookie", async (context) => {
    const platform = context.req.param("platform");
    const payload = await context.req.json<Record<string, unknown>>();
    const requiredField = { bilibili: "sessdata", zhihu: "z_c0" }[platform];
    if (!requiredField) {
      return context.json({ detail: `unsupported platform: ${platform}` }, 400);
    }
    if (typeof payload[requiredField] !== "string" || payload[requiredField].length === 0) {
      return context.json({ detail: `缺少必填字段: ${requiredField}` }, 400);
    }
    try {
      return context.json(
        await createControlPlaneService(context.env).writeCookie(platform, payload),
      );
    } catch (error: unknown) {
      if (error instanceof UnsupportedCookiePlatformError) {
        return context.json({ detail: `unsupported platform: ${platform}` }, 400);
      }
      if (error instanceof MissingCookieFieldError) {
        return context.json({ detail: `缺少必填字段: ${error.message}` }, 400);
      }
      throw error;
    }
  });
  app.get("/login/:platform/status", async (context) =>
    context.json(
      await createControlPlaneService(context.env).getLoginStatus(
        context.req.param("platform"),
      ),
    ),
  );

  app.use("/api/operations/*", requireApiKey);
  app.get("/api/operations/overview", async (context) =>
    context.json(await createOperationsService(context.env).getOverview()),
  );
  app.get("/api/operations/sync-jobs", async (context) => {
    const limit = readLimit(context.req.query("limit"));
    if (limit === null) return context.json({ detail: "invalid limit" }, 422);
    const items = await createOperationsService(context.env).listSyncJobs(limit);
    return context.json({ items, status: "ok" });
  });
  app.get("/api/operations/article-events", async (context) => {
    const limit = readLimit(context.req.query("limit"));
    if (limit === null) return context.json({ detail: "invalid limit" }, 422);
    const items = await createOperationsService(context.env).listArticleEvents(limit);
    return context.json({ items, status: "ok" });
  });

  app.use("/sync", requireApiKey);
  app.post("/sync", async (context) => {
    if (context.env.SYNC_PUBLISH_ENABLED !== "true") {
      return context.json({ detail: "sync queue consumer unavailable" }, 503);
    }
    return context.json(await createOperationsService(context.env).requestManualSync());
  });

  app.use("/internal/operations/*", requireWorkerToken);
  app.use("/internal/*", requireWorkerToken);
  app.post("/internal/queue/pull", async (context) => {
    const parsed = inboxPullSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ detail: "invalid queue pull request" }, 400);
    return context.json(await createQueueInboxService(context.env).pull(parsed.data));
  });
  app.post("/internal/queue/settle", async (context) => {
    const parsed = inboxSettlementSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ detail: "invalid queue settlement" }, 400);
    await createQueueInboxService(context.env).settle({
      acks: parsed.data.acks,
      retries: parsed.data.retries.map((retry) =>
        retry.delaySeconds === undefined
          ? { leaseId: retry.leaseId }
          : { delaySeconds: retry.delaySeconds, leaseId: retry.leaseId },
      ),
    });
    return context.body(null, 204);
  });
  app.put("/internal/operations/snapshot", async (context) => {
    const parsed = operationsOverviewSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ detail: "invalid operations snapshot" }, 400);
    await createOperationsService(context.env).replaceSnapshot(parsed.data);
    return context.body(null, 204);
  });

  app.post("/internal/jobs/claim", async (context) => {
    const body = await context.req.json<{ job?: unknown }>();
    try {
      return context.json(
        await createControlPlaneService(context.env).claimJob(
          body.job as Parameters<ControlPlaneService["claimJob"]>[0],
        ),
      );
    } catch {
      return context.json({ detail: "invalid queue job" }, 400);
    }
  });
  app.put("/internal/jobs/:jobId/result", async (context) =>
    context.json(
      await createControlPlaneService(context.env).finishJob(
        context.req.param("jobId"),
        await context.req.json(),
      ),
    ),
  );
  app.post("/internal/dead-letters/:jobId/replay", async (context) => {
    const parsed = replayDeadLetterSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ detail: "invalid replay request" }, 400);
    return context.json(
      await createControlPlaneService(context.env).replayDeadLetter(
        context.req.param("jobId"),
        parsed.data,
      ),
    );
  });
  app.post("/internal/jobs/publish", async (context) => {
    const body = await context.req.json<{ jobs: Parameters<ControlPlaneService["publishJobs"]>[0] }>();
    return context.json(await createControlPlaneService(context.env).publishJobs(body.jobs));
  });
  app.post("/internal/jobs/reject", async (context) => {
    await createControlPlaneService(context.env).rejectInvalidJob(
      await context.req.json(),
    );
    return context.body(null, 204);
  });
  app.post("/internal/effects/claim", async (context) =>
    context.json(
      await createControlPlaneService(context.env).claimEffect(await context.req.json()),
    ),
  );
  app.put("/internal/effects/:effectKey/result", async (context) => {
    await createControlPlaneService(context.env).finishEffect(
      context.req.param("effectKey"),
      await context.req.json(),
    );
    return context.body(null, 204);
  });
  app.post("/internal/rate-limits/consume", async (context) =>
    context.json(
      await createControlPlaneService(context.env).consumeRateLimit(
        await context.req.json(),
      ),
    ),
  );
  app.post("/internal/rate-limits/consume-batch", async (context) => {
    const parsed = rateLimitBatchSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ detail: "invalid rate limit batch" }, 400);
    return context.json(
      await createControlPlaneService(context.env).consumeRateLimits(parsed.data.inputs),
    );
  });
  app.post("/internal/state/read", async (context) => {
    const { key } = await context.req.json<{ key: string }>();
    return context.json({ value: await createControlPlaneService(context.env).getState(key) });
  });
  app.put("/internal/state", async (context) => {
    const { key, value } = await context.req.json<{ key: string; value: unknown }>();
    await createControlPlaneService(context.env).putState(key, value);
    return context.body(null, 204);
  });
  app.get("/internal/credentials/:name", async (context) => {
    const value = await createControlPlaneService(context.env).getCredential(
      context.req.param("name"),
    );
    return value === null
      ? context.json({ detail: "credential not found" }, 404)
      : context.json({ value });
  });
  app.put("/internal/login/:platform/status", async (context) => {
    await createControlPlaneService(context.env).putLoginSession(
      context.req.param("platform"),
      await context.req.json(),
    );
    return context.body(null, 204);
  });
  app.put("/internal/heartbeat", async (context) => {
    const { details, workerId } = await context.req.json<{
      details: Record<string, unknown>;
      workerId: string;
    }>();
    await createControlPlaneService(context.env).recordHeartbeat(workerId, details);
    return context.body(null, 204);
  });
  app.post("/internal/article-events", async (context) => {
    await createControlPlaneService(context.env).recordArticleEvent(
      await context.req.json(),
    );
    return context.body(null, 204);
  });
  app.post("/internal/migration/import", async (context) =>
    context.json(
      await createLegacyMigrationService(context.env).importSnapshot(
        await context.req.json(),
      ),
    ),
  );

  return app;
}

function readLimit(value: string | undefined): number | null {
  if (value === undefined) return 20;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}
