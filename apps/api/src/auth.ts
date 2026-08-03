import type { MiddlewareHandler } from "hono";

import type { QueueJob } from "@inbox/domain";

export interface ApiBindings {
  readonly ADMIN_API_KEY?: string;
  readonly CF_VERSION_METADATA?: {
    readonly id: string;
    readonly tag: string;
    readonly timestamp: string;
  };
  readonly CONSOLE_ORIGINS?: string;
  readonly DB: D1Database;
  readonly DEPLOYMENT_VERSION?: string;
  readonly JOBS: Queue<QueueJob>;
  readonly SCHEDULE_ENABLED?: string;
  readonly STATE_ENCRYPTION_KEY?: string;
  readonly SYNC_PUBLISH_ENABLED?: string;
  readonly WORKER_SERVICE_TOKEN?: string;
}

type ApiEnvironment = { Bindings: ApiBindings };

export const requireApiKey: MiddlewareHandler<ApiEnvironment> = async (
  context,
  next,
) => {
  const configuredKey = context.env.ADMIN_API_KEY?.trim();
  if (!configuredKey) {
    return context.json({ detail: "admin authentication unavailable" }, 503);
  }
  if (context.req.header("X-API-Key") !== configuredKey) {
    return context.json({ detail: "invalid api key" }, 401);
  }
  await next();
};

export const requireWorkerToken: MiddlewareHandler<ApiEnvironment> = async (
  context,
  next,
) => {
  const configuredToken = context.env.WORKER_SERVICE_TOKEN?.trim();
  const suppliedToken = bearerToken(context.req.header("Authorization"));
  if (!configuredToken || suppliedToken !== configuredToken) {
    return context.json({ detail: "invalid worker token" }, 401);
  }
  await next();
};

function bearerToken(authorization: string | undefined): string | undefined {
  const prefix = "Bearer ";
  return authorization?.startsWith(prefix)
    ? authorization.slice(prefix.length)
    : undefined;
}
