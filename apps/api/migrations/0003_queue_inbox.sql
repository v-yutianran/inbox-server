CREATE TABLE IF NOT EXISTS worker_inbox (
    message_id TEXT PRIMARY KEY NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_id TEXT,
    lease_until TEXT,
    available_at TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS worker_inbox_lease_id_uq
ON worker_inbox(lease_id)
WHERE lease_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS worker_inbox_available_idx
ON worker_inbox(status, available_at, created_at);
