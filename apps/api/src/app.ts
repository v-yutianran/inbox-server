import { Hono } from "hono";
import { cors } from "hono/cors";

import type { ApiBindings } from "./auth.js";
import { isAllowedConsoleOrigin } from "./cors.js";

export function createApp(): Hono<{ Bindings: ApiBindings }> {
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

  return app;
}
