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
}

export async function startHealthServer(
  options: HealthServerOptions,
): Promise<Server> {
  const now = options.now ?? Date.now;
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      writeJson(response, { body: { status: "starting" }, status: 503 });
      return;
    }
    if (request.url === "/healthz") {
      writeJson(
        response,
        evaluateLiveness(options.getState(), now(), options.staleAfterMs),
      );
      return;
    }
    if (request.url === "/readyz") {
      writeJson(response, evaluateReadiness(options.getState()));
      return;
    }
    response.writeHead(404).end();
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

export async function closeHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeJson(
  response: ServerResponse,
  result: ProbeResult,
): void {
  response.writeHead(result.status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result.body));
}
