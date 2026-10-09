import type { PostgresPool } from "./queue-inbox-postgres.js";

export interface WorkerHeartbeat extends Record<string, unknown> {
  readonly details: string;
  readonly last_seen_at: string;
  readonly worker_id: string;
}

export interface WorkerHeartbeatCache {
  get(): Promise<WorkerHeartbeat | null>;
  setIfNewer(value: WorkerHeartbeat): Promise<void>;
}

const CACHE_KEY = "inbox-server:worker-heartbeat:latest";
const HEARTBEAT_TTL_SECONDS = 90;
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_HEARTBEAT_AGE_MS = HEARTBEAT_TTL_SECONDS * 1_000;

const SET_IF_NEWER_SCRIPT = `
local incoming = cjson.decode(ARGV[1])
local currentRaw = redis.call("GET", KEYS[1])
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  local currentTimestamp = ok and tonumber(current.timestamp_ms) or nil
  if currentTimestamp and type(current.worker_id) == "string" then
    if currentTimestamp > incoming.timestamp_ms or
       (currentTimestamp == incoming.timestamp_ms and current.worker_id > incoming.worker_id) then
      return 0
    end
  end
end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return 1`;

export function createUpstashHeartbeatCache(
  url: string,
  token: string,
  fetcher: typeof fetch = fetch,
): WorkerHeartbeatCache {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("Upstash REST URL must use HTTPS without credentials");
  }
  const authorization = `Bearer ${token}`;

  async function command(command: readonly (string | number)[]): Promise<unknown> {
    const operation = command[0] === "GET" ? "get" : "set";
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) {
        logCacheFailure(operation, "http");
        return null;
      }
      const body = await response.json() as { result?: unknown };
      if (!Object.hasOwn(body, "result")) {
        logCacheFailure(operation, "response");
        return null;
      }
      return body.result ?? null;
    } catch {
      logCacheFailure(operation, "request");
      return null;
    }
  }

  return {
    async get() {
      const result = await command(["GET", CACHE_KEY]);
      if (typeof result !== "string") return null;
      try {
        const heartbeat = parseHeartbeat(JSON.parse(result) as unknown);
        if (!heartbeat) logCacheFailure("get", "payload");
        return heartbeat;
      } catch {
        logCacheFailure("get", "payload");
        return null;
      }
    },

    async setIfNewer(value) {
      const timestamp = Date.parse(value.last_seen_at);
      if (!Number.isFinite(timestamp)) return;
      await command([
        "EVAL",
        SET_IF_NEWER_SCRIPT,
        1,
        CACHE_KEY,
        JSON.stringify({ ...value, timestamp_ms: timestamp }),
        HEARTBEAT_TTL_SECONDS,
      ]);
    },
  };
}

function logCacheFailure(
  operation: "get" | "set",
  reason: "http" | "payload" | "request" | "response",
): void {
  console.warn(JSON.stringify({
    event: "upstash.heartbeat_cache.failure",
    operation,
    reason,
  }));
}

export function createWorkerHeartbeatCache(
  url: string | undefined,
  token: string | undefined,
): WorkerHeartbeatCache | undefined {
  if (!url?.trim() || !token?.trim()) return undefined;
  try {
    return createUpstashHeartbeatCache(url.trim(), token.trim());
  } catch {
    return undefined;
  }
}

export async function readLatestWorkerHeartbeat(options: {
  readonly cache?: WorkerHeartbeatCache | undefined;
  readonly now: Date;
  readonly pool: PostgresPool;
}): Promise<WorkerHeartbeat | null> {
  let cached: WorkerHeartbeat | null = null;
  try {
    cached = await options.cache?.get() ?? null;
  } catch {
    // Cache failures always fall back to PostgreSQL, the authoritative store.
  }
  if (cached && isFreshHeartbeat(cached, options.now)) return cached;

  const client = await options.pool.connect();
  let heartbeat: WorkerHeartbeat | null;
  try {
    const result = await client.query<WorkerHeartbeat>(
      `SELECT details, last_seen_at, worker_id FROM inbox_server.worker_heartbeats
       ORDER BY last_seen_at::timestamptz DESC, worker_id DESC LIMIT 1`,
    );
    heartbeat = result.rows[0] ?? null;
  } finally {
    await client.release();
  }
  await cacheFreshHeartbeat(options.cache, heartbeat, options.now);
  return heartbeat;
}

export async function cacheFreshHeartbeat(
  cache: WorkerHeartbeatCache | undefined,
  heartbeat: WorkerHeartbeat | null,
  now: Date,
): Promise<void> {
  if (!cache || !heartbeat || !isFreshHeartbeat(heartbeat, now)) return;
  try {
    await cache.setIfNewer(heartbeat);
  } catch {
    // Cache writes cannot affect the committed PostgreSQL heartbeat.
  }
}

function isFreshHeartbeat(heartbeat: WorkerHeartbeat, now: Date): boolean {
  const timestamp = Date.parse(heartbeat.last_seen_at);
  if (!Number.isFinite(timestamp) || !heartbeat.worker_id || typeof heartbeat.details !== "string") {
    return false;
  }
  const age = now.getTime() - timestamp;
  return age >= -MAX_FUTURE_SKEW_MS && age <= MAX_HEARTBEAT_AGE_MS;
}

function parseHeartbeat(value: unknown): WorkerHeartbeat | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  return typeof row.details === "string" &&
    typeof row.last_seen_at === "string" &&
    typeof row.worker_id === "string"
    ? { details: row.details, last_seen_at: row.last_seen_at, worker_id: row.worker_id }
    : null;
}
