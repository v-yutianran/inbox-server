import { parseQueueJob } from "@inbox/domain";

import type { ControlPlaneService } from "./control-plane.js";
import {
  MissingCookieFieldError,
  UnsupportedCookiePlatformError,
} from "./control-plane.js";
import { decryptJson, encryptJson } from "./credential-crypto.js";
import type { QueueProducer } from "./queue-producer.js";
import type { PostgresPool } from "./queue-inbox-postgres.js";
import {
  cacheFreshHeartbeat,
  type WorkerHeartbeat,
  type WorkerHeartbeatCache,
} from "./heartbeat-cache.js";

type ItemKind = "link" | "text" | "file" | "article";
type JsonRecord = Readonly<Record<string, unknown>>;
type DataService = Pick<
  ControlPlaneService,
  | "getChannels"
  | "getCredential"
  | "getLoginStatus"
  | "getQueueDlq"
  | "getQueueSummary"
  | "getState"
  | "publishJobs"
  | "putLoginSession"
  | "putState"
  | "recordArticleEvent"
  | "recordHeartbeat"
  | "rejectInvalidJob"
  | "saveInoreaderSessionCredential"
  | "writeCookie"
>;
type PostgresClient = Awaited<ReturnType<PostgresPool["connect"]>>;

const ITEM_KINDS: readonly ItemKind[] = ["link", "text", "file", "article"];

export function createPostgresControlPlaneDataService(options: {
  readonly encryptionKey: string;
  readonly now?: () => Date;
  readonly heartbeatCache?: WorkerHeartbeatCache | undefined;
  readonly pool: PostgresPool;
  readonly producer: QueueProducer;
}): DataService {
  const now = options.now ?? (() => new Date());
  const nowIso = () => now().toISOString();

  async function getState(key: string): Promise<unknown | null> {
    return withClient(options.pool, async (client) => {
      const result = await client.query<{ value: string } & Record<string, unknown>>(
        "SELECT value FROM inbox_server.worker_state WHERE key = $1",
        [key],
      );
      const row = result.rows[0];
      return row === undefined ? null : JSON.parse(row.value) as unknown;
    });
  }

  async function putState(key: string, value: unknown): Promise<void> {
    await withClient(options.pool, async (client) => {
      await client.query(
        `INSERT INTO inbox_server.worker_state (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(value), nowIso()],
      );
    });
  }

  return {
    async getChannels() {
      const channels = await getState("channels:safe");
      return {
        destinations: isRecord(channels) && isRecord(channels.destinations)
          ? channels.destinations
          : {},
        sources: isRecord(channels) && isRecord(channels.sources) ? channels.sources : {},
        status: "ok",
      };
    },

    async getCredential(name) {
      return withClient(options.pool, async (client) => {
        const result = await client.query<{ payload_encrypted: Uint8Array } & Record<string, unknown>>(
          `SELECT payload_encrypted FROM inbox_server.credentials WHERE name = $1`,
          [name],
        );
        const row = result.rows[0];
        return row === undefined ? null : decryptJson(row.payload_encrypted, options.encryptionKey);
      });
    },

    async getLoginStatus(platform) {
      return withClient(options.pool, async (client) => {
        const result = await client.query<{
          expires_at: string | null;
          last_error: string | null;
          last_used_at: string | null;
          status: string;
        } & Record<string, unknown>>(
          `SELECT status, expires_at, last_used_at, last_error
           FROM inbox_server.login_sessions WHERE platform = $1`,
          [platform],
        );
        const row = result.rows[0];
        return row
          ? {
              expires_at: row.expires_at,
              last_error: row.last_error,
              last_used_at: row.last_used_at,
              platform,
              session_status: row.status,
              status: "ok",
            }
          : {
              note: "尚未建立登录会话（需先同步触发 worker 登录）",
              platform,
              session_status: "none",
              status: "ok",
            };
      });
    },

    async getQueueDlq() {
      return withClient(options.pool, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT job_id, dedupe_key, kind, item_kind, attempts, error_class,
                  error_message, payload_digest, created_at
           FROM inbox_server.worker_dead_letters ORDER BY created_at DESC LIMIT 100`,
        );
        const dlq = Object.fromEntries(
          ITEM_KINDS.map((kind) => [kind, [] as unknown[]]),
        ) as Record<ItemKind, unknown[]>;
        for (const row of result.rows) {
          const kind = ITEM_KINDS.find((value) => value === row.item_kind);
          if (kind) dlq[kind].push(row);
        }
        return {
          counts: Object.fromEntries(ITEM_KINDS.map((kind) => [kind, dlq[kind].length])),
          dlq,
          status: "ok",
        };
      });
    },

    async getQueueSummary() {
      return withClient(options.pool, async (client) => {
        const jobs = await client.query<{
          count: number | string;
          item_kind: string;
          status: string;
        } & Record<string, unknown>>(
          `SELECT item_kind, status, COUNT(*) AS count FROM inbox_server.worker_jobs
           WHERE item_kind IS NOT NULL GROUP BY item_kind, status`,
        );
        const dead = await client.query<{
          count: number | string;
          item_kind: string;
        } & Record<string, unknown>>(
          `SELECT item_kind, COUNT(*) AS count FROM inbox_server.worker_dead_letters
           WHERE item_kind IS NOT NULL GROUP BY item_kind`,
        );
        const queues = emptyQueueSummary();
        for (const row of jobs.rows) {
          if (!ITEM_KINDS.includes(row.item_kind as ItemKind)) continue;
          const queue = queues[row.item_kind as ItemKind];
          if (row.status === "done") queue.done = Number(row.count);
          if (["processing", "deferred", "failed"].includes(row.status)) {
            queue.pending += Number(row.count);
          }
        }
        for (const row of dead.rows) {
          if (ITEM_KINDS.includes(row.item_kind as ItemKind)) {
            queues[row.item_kind as ItemKind].dlq = Number(row.count);
          }
        }
        return { queues, status: "ok" };
      });
    },

    getState,

    async publishJobs(inputs) {
      const jobs = inputs.map((input) => parseQueueJob(input));
      await options.producer.sendBatch(jobs);
      return { queued: jobs.length };
    },

    async putLoginSession(platform, input) {
      const encrypted = await encryptJson(input.state, options.encryptionKey);
      const timestamp = nowIso();
      await withClient(options.pool, async (client) => {
        await client.query(
          `INSERT INTO inbox_server.login_sessions
           (platform, storage_state_encrypted, status, expires_at, last_used_at,
            last_error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (platform) DO UPDATE SET
             storage_state_encrypted = EXCLUDED.storage_state_encrypted,
             status = EXCLUDED.status, expires_at = EXCLUDED.expires_at,
             last_used_at = EXCLUDED.last_used_at, last_error = EXCLUDED.last_error,
             updated_at = EXCLUDED.updated_at`,
          [
            platform,
            encrypted,
            input.status,
            input.expiresAt,
            timestamp,
            input.lastError ?? null,
            timestamp,
            timestamp,
          ],
        );
      });
    },

    putState,

    async recordArticleEvent(event) {
      await withClient(options.pool, async (client) => {
        await client.query(
          `INSERT INTO inbox_server.article_archive_events
           (source_url, url_fingerprint, title, status, reason, filename, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            event.sourceUrl,
            event.urlFingerprint,
            event.title,
            event.status,
            event.reason,
            event.filename,
            nowIso(),
          ],
        );
      });
    },

    async recordHeartbeat(workerId, details) {
      const timestamp = nowIso();
      const heartbeat = await withClient(options.pool, async (client) => {
        await client.query(
          `INSERT INTO inbox_server.worker_heartbeats AS hb
           (worker_id, last_seen_at, details)
           VALUES ($1, $2, $3)
           ON CONFLICT (worker_id) DO UPDATE SET
             last_seen_at = EXCLUDED.last_seen_at, details = EXCLUDED.details
           WHERE hb.last_seen_at::timestamptz <= EXCLUDED.last_seen_at::timestamptz`,
          [workerId, timestamp, JSON.stringify(details)],
        );
        const result = await client.query<WorkerHeartbeat>(
          `SELECT details, last_seen_at, worker_id FROM inbox_server.worker_heartbeats
           ORDER BY last_seen_at::timestamptz DESC, worker_id DESC LIMIT 1`,
        );
        return result.rows[0] ?? null;
      });
      await cacheFreshHeartbeat(options.heartbeatCache, heartbeat, now());
    },

    async rejectInvalidJob(input) {
      const timestamp = nowIso();
      await withClient(options.pool, async (client) => {
        await client.query(
          `INSERT INTO inbox_server.worker_dead_letters
           (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
            payload_digest, created_at)
           VALUES ($1, $2, 'invalid', NULL, $3, 'permanent', $4, $5, $6)
           ON CONFLICT (job_id) DO NOTHING`,
          [
            input.messageId,
            `invalid:${input.messageId}`,
            input.attempts,
            input.reason.slice(0, 500),
            input.payloadDigest,
            timestamp,
          ],
        );
      });
    },

    async writeCookie(platform, payload) {
      const field = ({ bilibili: "sessdata", zhihu: "z_c0" } as const)[
        platform as "bilibili" | "zhihu"
      ];
      if (!field) throw new UnsupportedCookiePlatformError(platform);
      if (typeof payload[field] !== "string" || payload[field].length === 0) {
        throw new MissingCookieFieldError(field);
      }
      const encrypted = await encryptJson({ [field]: payload[field] }, options.encryptionKey);
      const timestamp = nowIso();
      const name = `${platform}_creds`;
      await withClient(options.pool, async (client) => {
        await client.query(
          `INSERT INTO inbox_server.credentials
           (name, platform, kind, payload_encrypted, created_at, updated_at)
           VALUES ($1, $2, 'cookie', $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET payload_encrypted = EXCLUDED.payload_encrypted,
             platform = EXCLUDED.platform, kind = EXCLUDED.kind,
             updated_at = EXCLUDED.updated_at`,
          [name, platform, encrypted, timestamp, timestamp],
        );
      });
      return {
        note: "凭据已存，登录态将在下次同步时由 worker 建立",
        platform,
        status: "ok",
        vault_id: name,
      };
    },

    async saveInoreaderSessionCredential(state) {
      const encrypted = await encryptJson(state, options.encryptionKey);
      const timestamp = nowIso();
      await withClient(options.pool, async (client) => {
        await client.query(
          `INSERT INTO inbox_server.credentials
           (name, platform, kind, payload_encrypted, created_at, updated_at)
           VALUES ($1, $2, 'session', $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET payload_encrypted = EXCLUDED.payload_encrypted,
             platform = EXCLUDED.platform, kind = EXCLUDED.kind,
             updated_at = EXCLUDED.updated_at`,
          ["inoreader_creds", "inoreader", encrypted, timestamp, timestamp],
        );
      });
    },
  };
}

function emptyQueueSummary(): Record<ItemKind, { dlq: number; done: number; pending: number }> {
  return Object.fromEntries(
    ITEM_KINDS.map((kind) => [kind, { dlq: 0, done: 0, pending: 0 }]),
  ) as Record<ItemKind, { dlq: number; done: number; pending: number }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withClient<T>(pool: PostgresPool, operation: (client: PostgresClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    await client.release();
  }
}
