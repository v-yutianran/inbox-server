PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telegram_offsets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_token_hash TEXT NOT NULL UNIQUE,
  update_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dida_sync_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  saved_titles TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(saved_titles)),
  last_sync TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS login_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL UNIQUE,
  storage_state_encrypted BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_encrypted BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS incremental_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL UNIQUE,
  known_keys TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(known_keys)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  triggered_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  stats TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS article_archive_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT NOT NULL,
  url_fingerprint TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reason TEXT,
  filename TEXT,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan TEXT,
  status TEXT,
  seats INTEGER NOT NULL DEFAULT 1,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS operations_snapshots (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS credentials_platform_idx ON credentials(platform);
CREATE INDEX IF NOT EXISTS article_archive_events_fingerprint_idx ON article_archive_events(url_fingerprint);
CREATE INDEX IF NOT EXISTS article_archive_events_status_idx ON article_archive_events(status);
CREATE INDEX IF NOT EXISTS article_archive_events_occurred_at_idx ON article_archive_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS sync_jobs_started_at_idx ON sync_jobs(started_at DESC);
