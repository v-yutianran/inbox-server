PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_jobs (
  dedupe_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  item_kind TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 1,
  summary TEXT CHECK (summary IS NULL OR json_valid(summary)),
  error_class TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS worker_dead_letters (
  job_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_kind TEXT,
  attempts INTEGER NOT NULL,
  error_class TEXT NOT NULL,
  error_message TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_effects (
  effect_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed', 'uncertain')),
  attempts INTEGER NOT NULL DEFAULT 1,
  error_class TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS worker_rate_limits (
  scope TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, bucket_key)
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details))
);

CREATE INDEX IF NOT EXISTS worker_jobs_status_idx ON worker_jobs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS worker_jobs_item_kind_idx ON worker_jobs(item_kind, status);
CREATE INDEX IF NOT EXISTS worker_dead_letters_kind_idx ON worker_dead_letters(item_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS worker_effects_status_idx ON worker_effects(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS article_archive_events_import_idx
  ON article_archive_events(url_fingerprint, status, occurred_at);
