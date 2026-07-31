import { Hono } from "hono";

import type { ApiBindings } from "./auth.js";

export function createApp(): Hono<{ Bindings: ApiBindings }> {
  const app = new Hono<{ Bindings: ApiBindings }>();

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ready" }));

  return app;
}
