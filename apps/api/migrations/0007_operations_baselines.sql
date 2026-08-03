CREATE TABLE IF NOT EXISTS operations_retention_samples (
  sample_date TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  window_days INTEGER NOT NULL CHECK (window_days IN (7, 30, 90)),
  cutoff_at TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  oldest_candidate_at TEXT,
  captured_at TEXT NOT NULL,
  deployment_version TEXT NOT NULL,
  PRIMARY KEY (sample_date, record_kind, window_days)
);

CREATE INDEX IF NOT EXISTS operations_retention_samples_captured_idx
ON operations_retention_samples(captured_at DESC, window_days, record_kind);

CREATE TABLE IF NOT EXISTS operations_alert_instances (
  policy_key TEXT PRIMARY KEY,
  comparison TEXT NOT NULL CHECK (comparison IN ('gt', 'lt')),
  threshold_value REAL NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'firing', 'recovered')),
  observed_value REAL NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_evaluated_at TEXT NOT NULL,
  last_transition_at TEXT NOT NULL,
  deployment_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations_alert_events (
  event_key TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'firing', 'recovered')),
  comparison TEXT NOT NULL CHECK (comparison IN ('gt', 'lt')),
  threshold_value REAL NOT NULL,
  observed_value REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  deployment_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS operations_alert_events_policy_idx
ON operations_alert_events(policy_key, occurred_at DESC);
