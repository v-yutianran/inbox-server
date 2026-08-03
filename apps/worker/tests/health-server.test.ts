import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkerHealthState, reduceWorkerHealthState } from "../src/health";
import { closeHealthServer, startHealthServer } from "../src/health-server";

describe("health server", () => {
  const servers: Awaited<ReturnType<typeof startHealthServer>>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeHealthServer(server)));
  });

  it("长耗时异步工作未完成时仍独立响应 liveness 和 readiness", async () => {
    let state = reduceWorkerHealthState(createWorkerHealthState(Date.now()), {
      at: Date.now(),
      type: "browser-ready",
    });
    const server = await startHealthServer({
      getState: () => state,
      port: 0,
      staleAfterMs: 90_000,
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const workload = new Promise<void>(() => undefined);

    const [liveness, readiness] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/healthz`),
      fetch(`http://127.0.0.1:${port}/readyz`),
      workload,
    ].slice(0, 2) as [Promise<Response>, Promise<Response>]);

    expect(liveness.status).toBe(200);
    expect(await liveness.json()).toMatchObject({ phase: "ready", status: "ok" });
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toMatchObject({ phase: "ready", status: "ready" });

    state = reduceWorkerHealthState(state, {
      at: Date.now(),
      type: "shutdown-started",
    });
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
  });
});
