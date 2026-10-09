import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createUpstashHeartbeatCache,
  createWorkerHeartbeatCache,
  readLatestWorkerHeartbeat,
  type WorkerHeartbeat,
} from "../src/heartbeat-cache.js";
import type { PostgresPool } from "../src/queue-inbox-postgres.js";

const newer: WorkerHeartbeat = {
  details: '{"state":"ready"}',
  last_seen_at: "2030-01-01T00:00:02.000Z",
  worker_id: "worker-b",
};

afterEach(() => vi.useRealTimers());

describe("Upstash worker heartbeat cache", () => {
  it("keeps concurrent writes monotonic and expires the key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const redis = fakeUpstash();
    const cache = createUpstashHeartbeatCache("https://cache.example.test", "secret", redis.fetcher);
    const older = { ...newer, last_seen_at: "2030-01-01T00:00:01.000Z", worker_id: "worker-a" };

    await Promise.all([cache.setIfNewer(older), cache.setIfNewer(newer)]);
    await Promise.all([cache.setIfNewer(newer), cache.setIfNewer(older)]);
    await expect(cache.get()).resolves.toEqual(newer);
    expect(redis.commands.map(([command]) => command)).toEqual(["EVAL", "EVAL", "EVAL", "EVAL", "GET"]);
    expect(redis.commands.filter(([command]) => command === "EVAL").every(([, script, keyCount, key, , ttl]) =>
      String(script).includes("currentTimestamp > incoming.timestamp_ms") &&
      keyCount === 1 && key === "inbox-server:worker-heartbeat:latest" && ttl === 90,
    )).toBe(true);

    vi.setSystemTime(new Date("2030-01-01T00:01:30.000Z"));
    await expect(cache.get()).resolves.toBeNull();
  });

  it("treats REST failures as cache misses and failed writes as best effort", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = createUpstashHeartbeatCache(
      "https://cache.example.test",
      "synthetic-token",
      async () => { throw new Error("synthetic network failure with token https://private.example.test"); },
    );

    try {
      await expect(cache.get()).resolves.toBeNull();
      await expect(cache.setIfNewer(newer)).resolves.toBeUndefined();
      expect(createWorkerHeartbeatCache("not a URL", "synthetic-token")).toBeUndefined();
      const logs = JSON.stringify(warning.mock.calls);
      expect(logs).toContain("upstash.heartbeat_cache.failure");
      expect(logs).not.toContain("synthetic-token");
      expect(logs).not.toContain("private.example.test");
    } finally {
      warning.mockRestore();
    }
  });

  it("falls back to Neon when cached heartbeat data is expired or stale", async () => {
    const latest = { ...newer, last_seen_at: "2030-01-01T00:01:59.000Z" };
    const calls: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(sql: string) {
            calls.push(sql);
            return { rows: [latest] };
          },
          async release() {},
        };
      },
    } as unknown as PostgresPool;
    const cache = {
      async get() { return { ...newer, last_seen_at: "2030-01-01T00:00:00.000Z" }; },
      setIfNewer: vi.fn(async () => undefined),
    };

    await expect(readLatestWorkerHeartbeat({
      cache,
      now: new Date("2030-01-01T00:02:00.000Z"),
      pool,
    })).resolves.toEqual(latest);
    expect(calls[0]).toContain("FROM inbox_server.worker_heartbeats");
    expect(cache.setIfNewer).toHaveBeenCalledWith(latest);
  });
});

function fakeUpstash() {
  let value: WorkerHeartbeat | null = null;
  let expiresAt = 0;
  const commands: (readonly unknown[])[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const command = JSON.parse(String(init?.body)) as unknown[];
    commands.push(command);
    if (command[0] === "GET") {
      if (Date.now() >= expiresAt) value = null;
      return Response.json({ result: value === null ? null : JSON.stringify(value) });
    }
    if (command[0] === "EVAL") {
      const incoming = JSON.parse(String(command[4])) as WorkerHeartbeat;
      const ttl = Number(command[5]);
      if (value === null || compare(incoming, value) >= 0) {
        value = incoming;
        expiresAt = Date.now() + ttl * 1_000;
      }
      return Response.json({ result: 1 });
    }
    return Response.json({ result: null });
  };
  return { commands, fetcher };
}

function compare(left: WorkerHeartbeat, right: WorkerHeartbeat): number {
  return left.last_seen_at.localeCompare(right.last_seen_at) ||
    left.worker_id.localeCompare(right.worker_id);
}
