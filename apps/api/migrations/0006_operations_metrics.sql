CREATE TABLE IF NOT EXISTS operations_metric_samples (
  metric_key TEXT NOT NULL,
  dimensions TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dimensions)),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  value REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  deployment_version TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (metric_key, dimensions, window_end)
);

CREATE INDEX IF NOT EXISTS operations_metric_samples_window_idx
ON operations_metric_samples(window_end DESC, metric_key);
