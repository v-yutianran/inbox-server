CREATE SCHEMA IF NOT EXISTS inbox_server_legacy;

CREATE TABLE IF NOT EXISTS inbox_server_legacy.volume_archives (
  archive_name TEXT PRIMARY KEY CHECK (
    archive_name IN ('inbox-server_pgdata', 'inbox-server_redisdata')
  ),
  image_version TEXT NOT NULL CHECK (image_version <> ''),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes BYTEA NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (octet_length(archive_bytes) = byte_length)
);

INSERT INTO inbox_server.schema_migrations (version)
VALUES ('0002_legacy_archive')
ON CONFLICT (version) DO NOTHING;
