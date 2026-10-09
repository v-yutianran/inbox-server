import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import {
  evaluateLiveness,
  evaluateReadiness,
  type ProbeResult,
  type WorkerHealthState,
} from "./health.js";

export interface HealthServerOptions {
  readonly getState: () => WorkerHealthState;
  readonly now?: () => number;
  readonly port: number;
  readonly staleAfterMs: number;
  readonly webhook?: WorkerWebhookHandler;
}

export type WorkerWebhookAvailability = "not_ready" | "ready" | "stopping";

export interface WorkerWebhookRequest {
  readonly authorization: string | undefined;
  readonly method: string | undefined;
}

export interface WorkerWebhookResponse {
  readonly body: { readonly status: "method_not_allowed" | "ok" | "unauthorized" | "unavailable" };
  readonly retryAfterSeconds?: 5;
  readonly status: 200 | 401 | 405 | 503;
}

export type WorkerWebhookHandler = (request: WorkerWebhookRequest) => Promise<WorkerWebhookResponse>;

// Cloud Run webhook requests have a 900s hard limit; preserve 180s to settle and respond.
const WEBHOOK_DRAIN_BUDGET_MS = 720_000;

export interface HealthRequest extends WorkerWebhookRequest {
  readonly url: string | undefined;
}

export type HealthResponse = ProbeResult | WorkerWebhookResponse | {
  readonly body: { readonly status: "not_found" | "method_not_allowed" };
  readonly status: 404 | 405;
};

export function createWorkerWebhookHandler(options: {
  readonly getAvailability: () => WorkerWebhookAvailability;
  readonly log: (event: string, context: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => number;
  readonly processBatch: () => Promise<number>;
  readonly token: string;
}): WorkerWebhookHandler {
  let busy = false;

  return async ({ method, authorization }) => {
    if (method !== "POST") {
      options.log("worker.webhook.rejected", { reasonCode: "method_not_allowed", status: 405 });
      return { body: { status: "method_not_allowed" }, status: 405 };
    }
    if (!hasValidBearerToken(authorization, options.token)) {
      options.log("worker.webhook.rejected", { reasonCode: "unauthorized", status: 401 });
      return { body: { status: "unauthorized" }, status: 401 };
    }
    const availability = options.getAvailability();
    if (busy || availability !== "ready") {
      options.log("worker.webhook.rejected", {
        reasonCode: busy ? "busy" : availability,
        status: 503,
      });
      return { body: { status: "unavailable" }, retryAfterSeconds: 5, status: 503 };
    }

    busy = true;
    const now = options.now ?? (() => performance.now());
    const startedAt = now();
    try {
      while (true) {
        if (now() - startedAt >= WEBHOOK_DRAIN_BUDGET_MS) {
          options.log("worker.webhook.failed", {
            durationMs: now() - startedAt,
            reasonCode: "drain_budget_exhausted",
            status: 503,
          });
          return { body: { status: "unavailable" }, retryAfterSeconds: 5, status: 503 };
        }
        if (await options.processBatch() === 0) break;
        const availability = options.getAvailability();
        if (availability !== "ready") {
          options.log("worker.webhook.failed", {
            durationMs: now() - startedAt,
            reasonCode: availability,
            status: 503,
          });
          return { body: { status: "unavailable" }, retryAfterSeconds: 5, status: 503 };
        }
      }
      options.log("worker.webhook.completed", {
        durationMs: now() - startedAt,
        status: 200,
      });
      return { body: { status: "ok" }, status: 200 };
    } catch {
      options.log("worker.webhook.failed", {
        durationMs: now() - startedAt,
        status: 503,
      });
      return { body: { status: "unavailable" }, retryAfterSeconds: 5, status: 503 };
    } finally {
      busy = false;
    }
  };
}

export async function startHealthServer(
  options: HealthServerOptions,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === "/webhooks/worker") request.resume();
    void handleHealthRequest(options, {
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    }).then((result) => {
      if (!response.destroyed) writeResponse(response, result);
    }).catch(() => {
      if (response.destroyed) return;
      writeResponse(response, {
          body: { status: "unavailable" },
          retryAfterSeconds: 5,
          status: 503,
        });
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function handleHealthRequest(
  options: Pick<HealthServerOptions, "getState" | "now" | "staleAfterMs" | "webhook">,
  request: HealthRequest,
): Promise<HealthResponse> {
  if (request.url === "/webhooks/worker") {
    if (!options.webhook) return { body: { status: "not_found" }, status: 404 };
    return options.webhook(request);
  }
  if (request.url === "/healthz") {
    if (request.method !== "GET") {
      return { body: { status: "method_not_allowed" }, status: 405 };
    }
    return evaluateLiveness(
      options.getState(),
      (options.now ?? Date.now)(),
      options.staleAfterMs,
    );
  }
  if (request.url === "/readyz") {
    if (request.method !== "GET") {
      return { body: { status: "method_not_allowed" }, status: 405 };
    }
    return evaluateReadiness(options.getState());
  }
  return { body: { status: "not_found" }, status: 404 };
}

export async function closeHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeResponse(
  response: ServerResponse,
  result: HealthResponse | { readonly body: unknown; readonly retryAfterSeconds?: number; readonly status: number },
): void {
  const retryAfterSeconds = "retryAfterSeconds" in result
    ? result.retryAfterSeconds
    : undefined;
  response.writeHead(result.status, {
    "Content-Type": "application/json",
    ...(retryAfterSeconds === undefined
      ? {}
      : { "Retry-After": String(retryAfterSeconds) }),
  });
  response.end(JSON.stringify(result.body));
}

function hasValidBearerToken(authorization: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const supplied = createHash("sha256").update(authorization.slice(prefix.length)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(supplied, expected);
}
