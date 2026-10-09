import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => {
  const pool = { connect: vi.fn() };
  const service = (methods: readonly string[]) =>
    Object.fromEntries(methods.map((method) => [method, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
  return {
    pool,
    createPool: vi.fn(() => pool),
    command: vi.fn(() => service(["claimJob", "finishJob"])),
    effects: vi.fn(() => service([
      "claimEffect",
      "consumeRateLimit",
      "consumeRateLimits",
      "finishEffect",
    ])),
    data: vi.fn(() => service([
      "getChannels",
      "getCredential",
      "getLoginStatus",
      "getQueueDlq",
      "getQueueSummary",
      "getState",
      "publishJobs",
      "putLoginSession",
      "putState",
      "recordArticleEvent",
      "recordHeartbeat",
      "rejectInvalidJob",
      "writeCookie",
    ])),
    replay: vi.fn(() => service(["replayDeadLetter"])),
    queue: vi.fn(() => service(["pull", "settle", "stage"])),
    operations: vi.fn(() => service([
      "getOverview",
      "listArticleEvents",
      "listSyncJobs",
      "replaceSnapshot",
      "requestManualSync",
      "requestScheduledSync",
    ])),
    readiness: vi.fn(() => service([
      "createReplayPlan",
      "getDlqConsistency",
      "getHealthComponents",
      "getMetrics",
      "getQueueSummary",
      "getRetentionReport",
    ])),
    capture: vi.fn(() => service(["captureMetrics"])),
  };
});

vi.mock("../src/postgres-connection.js", () => ({
  createHyperdrivePostgresPool: pg.createPool,
}));
vi.mock("../src/control-plane-postgres.js", () => ({
  createPostgresControlPlaneCommandService: pg.command,
}));
vi.mock("../src/control-plane-postgres-effects.js", () => ({
  createPostgresControlPlaneEffectsService: pg.effects,
}));
vi.mock("../src/control-plane-postgres-data.js", () => ({
  createPostgresControlPlaneDataService: pg.data,
}));
vi.mock("../src/control-plane-postgres-replay.js", () => ({
  createPostgresControlPlaneReplayService: pg.replay,
}));
vi.mock("../src/queue-inbox-postgres.js", () => ({
  createQueueInboxPostgresService: pg.queue,
}));
vi.mock("../src/operations-postgres.js", () => ({
  createPostgresOperationsService: pg.operations,
}));
vi.mock("../src/operations-readiness-postgres.js", () => ({
  createPostgresOperationsReadinessService: pg.readiness,
}));
vi.mock("../src/operations-readiness-postgres-capture.js", () => ({
  createPostgresOperationsReadinessCapture: pg.capture,
}));

import { createApp } from "../src/app.js";
import { createControlPlaneServiceFromBindings } from "../src/control-plane.js";
import { createOperationsServiceFromBindings } from "../src/operations.js";
import { createOperationsReadinessServiceFromBindings } from "../src/operations-readiness.js";
import { createQueueInboxServiceFromBindings } from "../src/queue-inbox.js";

describe("PostgreSQL backend wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps D1 as the default backend", () => {
    const bindings = testBindings();

    expect(() => createControlPlaneServiceFromBindings(bindings)).not.toThrow();
    expect(() => createQueueInboxServiceFromBindings(bindings)).not.toThrow();
    expect(() => createOperationsServiceFromBindings(bindings)).not.toThrow();
    expect(() => createOperationsReadinessServiceFromBindings(bindings)).not.toThrow();
    expect(pg.createPool).not.toHaveBeenCalled();
  });

  it("requires Hyperdrive instead of falling back to D1 when PostgreSQL is selected", () => {
    const bindings = testBindings({ DATA_BACKEND: "postgres" });

    for (const createService of [
      createControlPlaneServiceFromBindings,
      createQueueInboxServiceFromBindings,
      createOperationsServiceFromBindings,
      createOperationsReadinessServiceFromBindings,
    ]) {
      expect(() => createService(bindings)).toThrow(/HYPERDRIVE/);
    }
    expect(pg.createPool).not.toHaveBeenCalled();
  });

  it("rejects unknown backend values instead of silently using D1", () => {
    expect(() => createControlPlaneServiceFromBindings(testBindings({ DATA_BACKEND: "postgre" })))
      .toThrow(/DATA_BACKEND/);
    expect(pg.createPool).not.toHaveBeenCalled();
  });

  it("composes the complete PostgreSQL services from the selected binding", () => {
    const bindings = testBindings({
      DATA_BACKEND: "postgres",
      HYPERDRIVE: { connectionString: "postgresql://local/test" },
      UPSTASH_REST_TOKEN: "synthetic-token",
      UPSTASH_REST_URL: "https://cache.example.test",
    });

    const controlPlane = createControlPlaneServiceFromBindings(bindings);
    const queue = createQueueInboxServiceFromBindings(bindings);
    const operations = createOperationsServiceFromBindings(bindings);
    const readiness = createOperationsReadinessServiceFromBindings(bindings);

    expect(controlPlane).toEqual(expect.objectContaining({
      claimEffect: expect.any(Function),
      claimJob: expect.any(Function),
      getCredential: expect.any(Function),
      replayDeadLetter: expect.any(Function),
    }));
    expect(queue).toEqual(expect.objectContaining({ pull: expect.any(Function), stage: expect.any(Function) }));
    expect(operations).toEqual(expect.objectContaining({
      getOverview: expect.any(Function),
      listArticleEvents: expect.any(Function),
    }));
    expect(readiness).toEqual(expect.objectContaining({
      captureMetrics: expect.any(Function),
      getQueueSummary: expect.any(Function),
    }));
    expect(pg.command).toHaveBeenCalledOnce();
    expect(pg.effects).toHaveBeenCalledOnce();
    expect(pg.data).toHaveBeenCalledOnce();
    expect(pg.replay).toHaveBeenCalledOnce();
    expect(pg.queue).toHaveBeenCalledOnce();
    expect(pg.operations).toHaveBeenCalledOnce();
    expect(pg.readiness).toHaveBeenCalledOnce();
    expect(pg.capture).toHaveBeenCalledOnce();
    const factoryOptions = [pg.data, pg.operations, pg.readiness].map(
      (factory) => (factory.mock.calls as unknown as readonly (readonly unknown[])[])[0]?.[0],
    );
    for (const options of factoryOptions) {
      expect(options).toEqual(expect.objectContaining({
        heartbeatCache: expect.objectContaining({
          get: expect.any(Function),
          setIfNewer: expect.any(Function),
        }),
      }));
    }
  });

  it("blocks the legacy D1 import route before constructing its service in PostgreSQL mode", async () => {
    const legacyService = { importSnapshot: vi.fn() };
    const createLegacyMigrationService = vi.fn(() => legacyService);
    const app = createApp({ createLegacyMigrationService });
    const response = await app.request(
      "/internal/migration/import",
      {
        body: JSON.stringify({ schemaVersion: 1 }),
        headers: {
          Authorization: "Bearer worker-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      testBindings({ DATA_BACKEND: "postgres", WORKER_SERVICE_TOKEN: "worker-token" }),
    );

    expect(response.status).toBe(410);
    expect(createLegacyMigrationService).not.toHaveBeenCalled();
    expect(legacyService.importSnapshot).not.toHaveBeenCalled();
  });

  it("configures PostgreSQL with Hyperdrive bound and Node compatibility", () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

    expect(config).toMatch(/"compatibility_flags"\s*:\s*\[[^\]]*"nodejs_compat"/s);
    expect(config).toMatch(/"DATA_BACKEND"\s*:\s*"postgres"/);
    expect(config).toMatch(
      /"hyperdrive"\s*:\s*\[\s*\{\s*"binding"\s*:\s*"HYPERDRIVE"\s*,\s*"id"\s*:\s*"3d5cd4030a8c4b52ac378216d87daff2"/s,
    );
  });
});

function testBindings(overrides: Record<string, unknown> = {}) {
  const statement = {
    all: vi.fn().mockResolvedValue({ results: [] }),
    bind: vi.fn(function (this: unknown) { return this; }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
  };
  const database = {
    batch: vi.fn().mockResolvedValue([]),
    prepare: vi.fn(() => statement),
  };
  return {
    DB: database as unknown as D1Database,
    JOBS: { sendBatch: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  } as unknown as import("../src/auth.js").ApiBindings;
}
