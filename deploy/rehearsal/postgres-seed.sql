CREATE TABLE rehearsal_backup_marker (
  backup_id TEXT PRIMARY KEY,
  record_count INTEGER NOT NULL CHECK (record_count = 1)
);

INSERT INTO rehearsal_backup_marker (backup_id, record_count)
VALUES ('synthetic-postgres-v1', 1);
