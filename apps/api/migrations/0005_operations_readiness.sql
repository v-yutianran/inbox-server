CREATE INDEX IF NOT EXISTS worker_heartbeats_last_seen_idx
ON worker_heartbeats(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS worker_jobs_retention_idx
ON worker_jobs(status, finished_at);

CREATE INDEX IF NOT EXISTS worker_dead_letters_created_idx
ON worker_dead_letters(created_at DESC);

CREATE INDEX IF NOT EXISTS worker_replay_operations_updated_idx
ON worker_replay_operations(updated_at DESC);
