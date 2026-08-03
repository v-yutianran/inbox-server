PRAGMA foreign_keys = OFF;

ALTER TABLE worker_jobs RENAME TO worker_jobs_v3;

CREATE TABLE worker_jobs (
  dedupe_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  item_kind TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'deferred', 'done', 'failed', 'dead', 'uncertain')
  ),
  attempts INTEGER NOT NULL DEFAULT 1,
  failure_attempts INTEGER NOT NULL DEFAULT 0,
  deferral_count INTEGER NOT NULL DEFAULT 0,
  deferred_until TEXT,
  deferred_reason TEXT,
  summary TEXT CHECK (summary IS NULL OR json_valid(summary)),
  error_class TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

INSERT INTO worker_jobs (
  dedupe_key, job_id, kind, item_kind, status, attempts, summary, error_class,
  error_message, created_at, updated_at, finished_at
)
SELECT
  dedupe_key, job_id, kind, item_kind, status, attempts, summary, error_class,
  error_message, created_at, updated_at, finished_at
FROM worker_jobs_v3;

DROP TABLE worker_jobs_v3;

ALTER TABLE worker_dead_letters RENAME TO worker_dead_letters_v3;

CREATE TABLE worker_dead_letters (
  job_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_kind TEXT,
  attempts INTEGER NOT NULL,
  error_class TEXT NOT NULL,
  error_message TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  envelope_job_id TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO worker_dead_letters (
  job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
  payload_digest, created_at
)
SELECT
  job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
  payload_digest, created_at
FROM worker_dead_letters_v3;

DROP TABLE worker_dead_letters_v3;

CREATE TABLE worker_job_envelopes (
  job_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'dead', 'uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE worker_replay_operations (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('published', 'rejected')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE worker_rate_limit_batches (
  scope TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (json_valid(state)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX worker_jobs_status_idx ON worker_jobs(status, updated_at DESC);
CREATE INDEX worker_jobs_item_kind_idx ON worker_jobs(item_kind, status);
CREATE INDEX worker_dead_letters_kind_idx
  ON worker_dead_letters(item_kind, created_at DESC);
CREATE INDEX worker_job_envelopes_status_idx
  ON worker_job_envelopes(status, updated_at DESC);
CREATE INDEX worker_replay_operations_job_idx
  ON worker_replay_operations(job_id, created_at DESC);

PRAGMA foreign_keys = ON;
