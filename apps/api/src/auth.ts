import type { MiddlewareHandler } from "hono";

export interface ApiBindings {
  readonly ADMIN_API_KEY?: string;
  readonly WORKER_SERVICE_TOKEN?: string;
}

type ApiEnvironment = { Bindings: ApiBindings };

export const requireApiKey: MiddlewareHandler<ApiEnvironment> = async (
  context,
  next,
) => {
  const configuredKey = context.env.ADMIN_API_KEY?.trim();
  if (!configuredKey) {
    await next();
    return;
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
