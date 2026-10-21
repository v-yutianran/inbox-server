-- 从 Neon（schema inbox_server）导出桌面版可导入的明文 JSON。
-- 不导出 credentials、login_sessions、worker_job_envelopes 的密文。
--
-- psql "$NEON_DATABASE_URL" -At -v ON_ERROR_STOP=1 -f scripts/export-neon.sql -o cloud-export.json
-- 然后在桌面版目录执行:
-- INBOX_DESKTOP_HOME="$HOME/Library/Application Support/inbox-server-desktop" npm run import -- ./cloud-export.json

SELECT json_build_object(
  'format', 'inbox-cloud-export-v1',
  'exportedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'encryptedEnvelopeCount', (SELECT count(*) FROM inbox_server.worker_job_envelopes),
  'articleArchiveEvents', COALESCE((
    SELECT json_agg(json_build_object(
      'sourceUrl', source_url,
      'urlFingerprint', url_fingerprint,
      'title', title,
      'status', status,
      'reason', reason,
      'filename', filename,
      'occurredAt', occurred_at
    ) ORDER BY occurred_at)
    FROM inbox_server.article_archive_events
  ), '[]'::json),
  'workerState', COALESCE((
    SELECT json_agg(json_build_object(
      'key', key,
      'value', value::json,
      'updatedAt', updated_at
    ))
    FROM inbox_server.worker_state
  ), '[]'::json),
  'baselines', COALESCE((
    SELECT json_agg(json_build_object(
      'source', source,
      'knownKeys', known_keys::json,
      'updatedAt', updated_at
    ))
    FROM inbox_server.incremental_baselines
  ), '[]'::json),
  'syncJobs', COALESCE((
    SELECT json_agg(json_build_object(
      'id', id,
      'triggeredBy', triggered_by,
      'status', status,
      'stats', stats::json,
      'startedAt', started_at,
      'finishedAt', finished_at,
      'error', error
    ) ORDER BY started_at)
    FROM inbox_server.sync_jobs
  ), '[]'::json),
  'jobs', COALESCE((
    SELECT json_agg(json_build_object(
      'jobId', job_id,
      'dedupeKey', dedupe_key,
      'kind', kind,
      'itemKind', item_kind,
      'status', status,
      'errorMessage', error_message,
      'createdAt', created_at,
      'finishedAt', finished_at
    ) ORDER BY created_at)
    FROM inbox_server.worker_jobs
  ), '[]'::json)
);
