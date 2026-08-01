import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const telegramOffsets = sqliteTable("telegram_offsets", {
  botTokenHash: text("bot_token_hash").notNull().unique(),
  id: integer("id").primaryKey({ autoIncrement: true }),
  updateId: integer("update_id").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const didaSyncStates = sqliteTable("dida_sync_states", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lastSync: text("last_sync"),
  savedTitles: text("saved_titles", { mode: "json" }).$type<readonly string[]>().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  updatedAt: text("updated_at").notNull(),
});

export const loginSessions = sqliteTable("login_sessions", {
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  id: integer("id").primaryKey({ autoIncrement: true }),
  lastError: text("last_error"),
  lastUsedAt: text("last_used_at"),
  platform: text("platform").notNull().unique(),
  status: text("status").notNull(),
  storageStateEncrypted: blob("storage_state_encrypted").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const credentials = sqliteTable(
  "credentials",
  {
    createdAt: text("created_at").notNull(),
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    name: text("name").notNull().unique(),
    payloadEncrypted: blob("payload_encrypted").notNull(),
    platform: text("platform").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("credentials_platform_idx").on(table.platform)],
);

export const incrementalBaselines = sqliteTable("incremental_baselines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  knownKeys: text("known_keys", { mode: "json" }).$type<readonly string[]>().notNull(),
  source: text("source").notNull().unique(),
  updatedAt: text("updated_at").notNull(),
});

export const syncJobs = sqliteTable(
  "sync_jobs",
  {
    error: text("error"),
    finishedAt: text("finished_at"),
    id: text("id").primaryKey(),
    startedAt: text("started_at").notNull(),
    stats: text("stats", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    triggeredBy: text("triggered_by").notNull(),
  },
  (table) => [index("sync_jobs_started_at_idx").on(table.startedAt)],
);

export const articleArchiveEvents = sqliteTable(
  "article_archive_events",
  {
    filename: text("filename"),
    id: integer("id").primaryKey({ autoIncrement: true }),
    occurredAt: text("occurred_at").notNull(),
    reason: text("reason"),
    sourceUrl: text("source_url").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    urlFingerprint: text("url_fingerprint").notNull(),
  },
  (table) => [
    index("article_archive_events_fingerprint_idx").on(table.urlFingerprint),
    index("article_archive_events_status_idx").on(table.status),
    index("article_archive_events_occurred_at_idx").on(table.occurredAt),
  ],
);

export const subscriptions = sqliteTable("subscriptions", {
  createdAt: text("created_at").notNull(),
  currentPeriodEnd: text("current_period_end"),
  id: integer("id").primaryKey({ autoIncrement: true }),
  plan: text("plan"),
  seats: integer("seats").notNull(),
  status: text("status"),
});

export const operationsSnapshots = sqliteTable("operations_snapshots", {
  id: text("id").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: text("updated_at").notNull(),
});
