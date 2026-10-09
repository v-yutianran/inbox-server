#!/usr/bin/env python3
"""Safely resolve the one verified-missing uncertain article without replaying it."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import asyncpg

JOB_ID = "6832721e-9096-4fb7-873c-2ee56cae1072"
EFFECT_KEY = (
    "dispatch:article:44fb5bcb5c3aa27903e3c04ce4077ff2ac17a7c1d0b522324e8935ed5269bd43:"
    "article_archive"
)
FINGERPRINT = "44fb5bcb5c3aa27903e3c04ce4077ff2ac17a7c1d0b522324e8935ed5269bd43"
ARTICLE_EVENT_ID = 12014
EXPECTED_TARGET_MAIN_SHA = "1ae5c6b9ba499e984152086d5e2b0f3e7d7ac0dc"
AUDIT_KEY = f"manual-article-resolution:{JOB_ID}"
ERROR_MESSAGE = "target article absence verified; permanent manual resolution"
CHECKED_PATHS = ("raw/article", "references/article")


class ResolutionError(RuntimeError):
    """A fixed precondition or compare-and-set check failed."""


@dataclass(frozen=True)
class ResolutionReport:
    mode: str
    job_id: str


def _validate_target_sha(value: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", value) or value != EXPECTED_TARGET_MAIN_SHA:
        raise ResolutionError("target main commit does not match the verified evidence commit")


def _timestamp(value: datetime | None) -> str:
    current = value or datetime.now(UTC)
    if current.tzinfo is None:
        raise ResolutionError("timestamp must include a timezone")
    return current.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def resolve_uncertain_article(
    connection: Any,
    *,
    target_main_sha: str,
    apply: bool = False,
    now: datetime | None = None,
) -> ResolutionReport:
    """Validate the fixed record and optionally resolve it in one serializable transaction."""
    _validate_target_sha(target_main_sha)
    timestamp = _timestamp(now)
    lock_clause = " FOR UPDATE" if apply else ""
    async with connection.transaction(isolation="serializable", readonly=not apply):
        job = await connection.fetchrow(
            """SELECT job_id, dedupe_key, kind, item_kind, status, attempts, failure_attempts
               FROM inbox_server.worker_jobs WHERE job_id = $1""" + lock_clause,
            JOB_ID,
        )
        if not job or any(
            (
                job["job_id"] != JOB_ID,
                job["kind"] != "dispatch-item",
                job["item_kind"] != "article",
                job["status"] != "uncertain",
                int(job["attempts"]) != 1,
                int(job["failure_attempts"]) != 0,
            )
        ):
            raise ResolutionError(
                "job is missing or does not match the expected uncertain article state"
            )

        effects = await connection.fetch(
            """SELECT effect_key, job_id, destination, status, error_class
               FROM inbox_server.worker_effects WHERE job_id = $1""" + lock_clause,
            JOB_ID,
        )
        if len(effects) != 1 or any(
            (
                effects[0]["effect_key"] != EFFECT_KEY,
                effects[0]["job_id"] != JOB_ID,
                effects[0]["destination"] != "article_archive",
                effects[0]["status"] != "uncertain",
                effects[0]["error_class"] != "permanent",
            )
        ):
            raise ResolutionError("expected exactly one uncertain permanent article archive effect")

        envelope = await connection.fetchrow(
            """SELECT job_id, dedupe_key, payload_digest, status
               FROM inbox_server.worker_job_envelopes WHERE job_id = $1""" + lock_clause,
            JOB_ID,
        )
        if (
            not envelope
            or envelope["job_id"] != JOB_ID
            or envelope["dedupe_key"] != job["dedupe_key"]
            or envelope["status"] != "uncertain"
            or not envelope["payload_digest"]
        ):
            raise ResolutionError(
                "envelope is missing or does not match the expected uncertain article"
            )

        events = await connection.fetch(
            """SELECT id, url_fingerprint, status, reason, filename
               FROM inbox_server.article_archive_events
               WHERE url_fingerprint = $1""" + lock_clause,
            FINGERPRINT,
        )
        if len(events) != 1 or any(
            (
                events[0]["id"] != ARTICLE_EVENT_ID,
                events[0]["url_fingerprint"] != FINGERPRINT,
                events[0]["status"] != "failed",
                events[0]["reason"] != "zhihu_api_rejected",
                events[0]["filename"] is not None,
            )
        ):
            raise ResolutionError(
                "article archive event is missing or does not match the expected failure"
            )

        dead_letters = await connection.fetch(
            "SELECT job_id FROM inbox_server.worker_dead_letters WHERE job_id = $1" + lock_clause,
            JOB_ID,
        )
        replays = await connection.fetch(
            "SELECT job_id FROM inbox_server.worker_replay_operations "
            "WHERE job_id = $1" + lock_clause,
            JOB_ID,
        )
        inbox_rows = await connection.fetch(
            """SELECT message_id FROM inbox_server.worker_inbox
               WHERE body::jsonb ->> 'jobId' = $1""" + lock_clause,
            JOB_ID,
        )
        audit_row = await connection.fetchrow(
            "SELECT key FROM inbox_server.worker_state WHERE key = $1" + lock_clause,
            AUDIT_KEY,
        )
        if dead_letters or replays or inbox_rows or audit_row:
            raise ResolutionError("dead letter, replay, inbox, or audit record already exists")

        if not apply:
            return ResolutionReport(mode="dry-run", job_id=JOB_ID)

        audit_value = json.dumps(
            {
                "action": "manual_article_absence_resolution",
                "job_id": JOB_ID,
                "effect_key": EFFECT_KEY,
                "article_archive_event_id": ARTICLE_EVENT_ID,
                "target_main_sha": target_main_sha,
                "checked_paths": CHECKED_PATHS,
                "verification": "url_fingerprint_absent_from_target_repository",
                "from": {"job": "uncertain", "effect": "uncertain", "envelope": "uncertain"},
                "to": {"job": "dead", "effect": "failed", "envelope": "dead"},
                "replayed": False,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        audit_insert = await connection.fetchrow(
            """INSERT INTO inbox_server.worker_state (key, value, updated_at)
               VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key""",
            AUDIT_KEY,
            audit_value,
            timestamp,
        )
        if not audit_insert:
            raise ResolutionError("operation audit key was concurrently created")

        job_update = await connection.fetchrow(
            """UPDATE inbox_server.worker_jobs
               SET status = 'dead', failure_attempts = 1, error_class = 'permanent',
                   error_message = $1, finished_at = $2, updated_at = $2,
                   deferred_until = NULL, deferred_reason = NULL
               WHERE job_id = $3 AND kind = 'dispatch-item' AND item_kind = 'article'
                 AND status = 'uncertain' AND attempts = 1 AND failure_attempts = 0
               RETURNING job_id""",
            ERROR_MESSAGE,
            timestamp,
            JOB_ID,
        )
        if not job_update:
            raise ResolutionError("job compare-and-set affected no row")

        effect_update = await connection.fetchrow(
            """UPDATE inbox_server.worker_effects
               SET status = 'failed', error_class = 'permanent', error_message = $1,
                   finished_at = NULL, updated_at = $2
               WHERE effect_key = $3 AND job_id = $4 AND destination = 'article_archive'
                 AND status = 'uncertain' AND error_class = 'permanent'
               RETURNING effect_key""",
            ERROR_MESSAGE,
            timestamp,
            EFFECT_KEY,
            JOB_ID,
        )
        if not effect_update:
            raise ResolutionError("effect compare-and-set affected no row")

        envelope_update = await connection.fetchrow(
            """UPDATE inbox_server.worker_job_envelopes
               SET status = 'dead', updated_at = $1
               WHERE job_id = $2 AND dedupe_key = $3 AND status = 'uncertain'
               RETURNING job_id""",
            timestamp,
            JOB_ID,
            job["dedupe_key"],
        )
        if not envelope_update:
            raise ResolutionError("envelope compare-and-set affected no row")

        dead_letter = await connection.fetchrow(
            """INSERT INTO inbox_server.worker_dead_letters
               (job_id, dedupe_key, kind, item_kind, attempts, error_class, error_message,
                payload_digest, envelope_job_id, created_at)
               VALUES ($1, $2, 'dispatch-item', 'article', 1, 'permanent', $3, $4, $1, $5)
               ON CONFLICT (job_id) DO NOTHING RETURNING job_id""",
            JOB_ID,
            job["dedupe_key"],
            ERROR_MESSAGE,
            envelope["payload_digest"],
            timestamp,
        )
        if not dead_letter:
            raise ResolutionError("dead letter insert affected no row")

    return ResolutionReport(mode="applied", job_id=JOB_ID)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="只读核对（默认）")
    mode.add_argument("--apply", action="store_true", help="提交单条目标状态变更")
    parser.add_argument(
        "--target-main-sha",
        required=True,
        help="人工确认目标仓库 main 缺少该文章时的完整 commit SHA",
    )
    return parser


async def _run(*, target_main_sha: str, apply: bool) -> ResolutionReport:
    database_url = os.environ.get("INBOX_MIGRATION_DATABASE_URL")
    if not database_url:
        raise ResolutionError("INBOX_MIGRATION_DATABASE_URL is required")
    connection = await asyncpg.connect(database_url)
    try:
        return await resolve_uncertain_article(
            connection,
            target_main_sha=target_main_sha,
            apply=apply,
        )
    finally:
        await connection.close()


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        _validate_target_sha(args.target_main_sha)
        report = asyncio.run(_run(target_main_sha=args.target_main_sha, apply=args.apply))
    except ResolutionError as error:
        print(f"resolution rejected: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(
            f"database operation failed ({type(error).__name__}); details suppressed",
            file=sys.stderr,
        )
        return 1
    print(f"mode={report.mode} job_id={report.job_id} inbox_inserted=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
