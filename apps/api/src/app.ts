import { Hono } from "hono";
import { cors } from "hono/cors";

import { requireApiKey, requireWorkerToken, type ApiBindings } from "./auth.js";
import { isAllowedConsoleOrigin } from "./cors.js";
import {
  createOperationsServiceFromBindings,
  operationsOverviewSchema,
  type OperationsService,
} from "./operations.js";

interface AppOptions {
  readonly createOperationsService?: (bindings: ApiBindings) => OperationsService;
}

export function createApp({
  createOperationsService = createOperationsServiceFromBindings,
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
  app.put("/internal/operations/snapshot", async (context) => {
    const parsed = operationsOverviewSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ detail: "invalid operations snapshot" }, 400);
    await createOperationsService(context.env).replaceSnapshot(parsed.data);
    return context.body(null, 204);
  });

  return app;
}

function readLimit(value: string | undefined): number | null {
  if (value === undefined) return 20;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}
