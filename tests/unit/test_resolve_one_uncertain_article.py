from __future__ import annotations

import json
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

import pytest

JOB_ID = "6832721e-9096-4fb7-873c-2ee56cae1072"
EFFECT_KEY = (
    "dispatch:article:44fb5bcb5c3aa27903e3c04ce4077ff2ac17a7c1d0b522324e8935ed5269bd43:"
    "article_archive"
)
FINGERPRINT = "44fb5bcb5c3aa27903e3c04ce4077ff2ac17a7c1d0b522324e8935ed5269bd43"
TARGET_MAIN_SHA = "1ae5c6b9ba499e984152086d5e2b0f3e7d7ac0dc"


class FakeConnection:
    def __init__(self) -> None:
        self.job = {
            "job_id": JOB_ID,
            "dedupe_key": f"dispatch:article:{FINGERPRINT}",
            "kind": "dispatch-item",
            "item_kind": "article",
            "status": "uncertain",
            "attempts": 1,
            "failure_attempts": 0,
        }
        self.effect = {
            "effect_key": EFFECT_KEY,
            "job_id": JOB_ID,
            "destination": "article_archive",
            "status": "uncertain",
            "error_class": "permanent",
            "attempts": 1,
        }
        self.envelope = {
            "job_id": JOB_ID,
            "dedupe_key": self.job["dedupe_key"],
            "payload_digest": "a" * 64,
            "status": "uncertain",
        }
        self.article_events = [
            {
                "id": 12014,
                "url_fingerprint": FINGERPRINT,
                "status": "failed",
                "reason": "zhihu_api_rejected",
                "filename": None,
            }
        ]
        self.dead_letters: list[dict[str, Any]] = []
        self.replay_operations: list[dict[str, Any]] = []
        self.inbox: list[dict[str, Any]] = []
        self.worker_state: dict[str, dict[str, Any]] = {}
        self.writes: list[str] = []
        self.queries: list[str] = []
        self.transaction_options: dict[str, Any] = {}
        self.fail_effect_cas = False

    @asynccontextmanager
    async def transaction(self, **options: Any):
        self.transaction_options = options
        before = deepcopy(
            (
                self.job,
                self.effect,
                self.envelope,
                self.dead_letters,
                self.worker_state,
                self.writes,
            )
        )
        try:
            yield
        except Exception:
            (
                self.job,
                self.effect,
                self.envelope,
                self.dead_letters,
                self.worker_state,
                self.writes,
            ) = before
            raise

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if "FROM inbox_server.worker_jobs" in normalized:
            return deepcopy(self.job)
        if "FROM inbox_server.worker_job_envelopes" in normalized:
            return deepcopy(self.envelope)
        if "FROM inbox_server.worker_state" in normalized:
            return deepcopy(self.worker_state.get(str(args[0])))
        if normalized.startswith("INSERT INTO inbox_server.worker_state"):
            self.writes.append(normalized)
            key, value, updated_at = args
            if key in self.worker_state:
                return None
            self.worker_state[key] = {
                "key": key,
                "value": json.loads(value),
                "updated_at": updated_at,
            }
            return {"key": key}
        if normalized.startswith("UPDATE inbox_server.worker_effects"):
            self.writes.append(normalized)
            if self.fail_effect_cas:
                return None
            self.effect.update(
                {
                    "status": "failed",
                    "error_class": "permanent",
                    "finished_at": None,
                    "updated_at": args[1],
                }
            )
            return {"effect_key": self.effect["effect_key"]}
        if normalized.startswith("UPDATE inbox_server.worker_jobs"):
            self.writes.append(normalized)
            self.job.update(
                {
                    "status": "dead",
                    "failure_attempts": 1,
                    "error_class": "permanent",
                    "updated_at": args[1],
                }
            )
            return {"job_id": JOB_ID}
        if normalized.startswith("UPDATE inbox_server.worker_job_envelopes"):
            self.writes.append(normalized)
            self.envelope.update({"status": "dead", "updated_at": args[0]})
            return {"job_id": JOB_ID}
        if normalized.startswith("INSERT INTO inbox_server.worker_dead_letters"):
            self.writes.append(normalized)
            record = {
                "job_id": args[0],
                "dedupe_key": args[1],
                "kind": "dispatch-item",
                "item_kind": "article",
                "attempts": 1,
                "error_class": "permanent",
                "error_message": args[2],
                "payload_digest": args[3],
                "envelope_job_id": args[0],
                "created_at": args[4],
            }
            self.dead_letters.append(record)
            return {"job_id": JOB_ID}
        raise AssertionError(f"unexpected fetchrow SQL: {normalized}")

    async def close(self) -> None:
        return None

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if "FROM inbox_server.worker_effects" in normalized:
            return [deepcopy(self.effect)]
        if "FROM inbox_server.article_archive_events" in normalized:
            return deepcopy(self.article_events)
        if "FROM inbox_server.worker_dead_letters" in normalized:
            return deepcopy(self.dead_letters)
        if "FROM inbox_server.worker_replay_operations" in normalized:
            return deepcopy(self.replay_operations)
        if "FROM inbox_server.worker_inbox" in normalized:
            return deepcopy(self.inbox)
        raise AssertionError(f"unexpected fetch SQL: {normalized}")


@pytest.mark.asyncio
async def test_apply_resolves_only_confirmed_article_without_inserting_inbox() -> None:
    try:
        from scripts import resolve_one_uncertain_article as resolver
    except ImportError:
        pytest.fail("scoped uncertain article resolver must exist")

    connection = FakeConnection()
    report = await resolver.resolve_uncertain_article(
        connection,
        target_main_sha=TARGET_MAIN_SHA,
        apply=True,
        now=datetime(2026, 9, 24, 5, 0, tzinfo=UTC),
    )

    assert report.mode == "applied"
    assert connection.job["status"] == "dead"
    assert connection.job["failure_attempts"] == 1
    assert connection.job["error_class"] == "permanent"
    assert connection.effect["status"] == "failed"
    assert connection.effect["finished_at"] is None
    assert connection.envelope["status"] == "dead"
    assert [letter["job_id"] for letter in connection.dead_letters] == [JOB_ID]
    assert connection.worker_state[resolver.AUDIT_KEY]["value"]["target_main_sha"] == TARGET_MAIN_SHA
    assert connection.inbox == []
    assert not any("INSERT INTO inbox_server.worker_inbox" in query for query in connection.writes)
    job_update = next(query for query in connection.writes if query.startswith("UPDATE inbox_server.worker_jobs"))
    assert "attempts = 1 AND failure_attempts = 0" in job_update


@pytest.mark.asyncio
async def test_dry_run_is_readonly_and_does_not_take_row_locks() -> None:
    from scripts import resolve_one_uncertain_article as resolver

    connection = FakeConnection()
    before = deepcopy((connection.job, connection.effect, connection.envelope))

    report = await resolver.resolve_uncertain_article(
        connection,
        target_main_sha=TARGET_MAIN_SHA,
        apply=False,
    )

    assert report.mode == "dry-run"
    assert connection.transaction_options == {"isolation": "serializable", "readonly": True}
    assert all("FOR UPDATE" not in query for query in connection.queries)
    assert connection.writes == []
    assert (connection.job, connection.effect, connection.envelope) == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("counter", "value"),
    [("attempts", 2), ("failure_attempts", 1)],
)
async def test_apply_rejects_nonmatching_attempt_counts_before_writing(
    counter: str,
    value: int,
) -> None:
    from scripts import resolve_one_uncertain_article as resolver

    connection = FakeConnection()
    connection.job[counter] = value

    with pytest.raises(resolver.ResolutionError, match="job is missing"):
        await resolver.resolve_uncertain_article(
            connection,
            target_main_sha=TARGET_MAIN_SHA,
            apply=True,
        )

    assert connection.writes == []
    assert connection.job["status"] == "uncertain"


@pytest.mark.asyncio
@pytest.mark.parametrize("existing_record", ["dead_letter", "replay", "inbox", "audit"])
async def test_apply_refuses_existing_dead_letter_replay_inbox_or_audit(
    existing_record: str,
) -> None:
    from scripts import resolve_one_uncertain_article as resolver

    connection = FakeConnection()
    if existing_record == "dead_letter":
        connection.dead_letters.append({"job_id": JOB_ID})
    elif existing_record == "replay":
        connection.replay_operations.append({"job_id": JOB_ID})
    elif existing_record == "inbox":
        connection.inbox.append({"message_id": "already-staged"})
    else:
        connection.worker_state[resolver.AUDIT_KEY] = {
            "key": resolver.AUDIT_KEY,
            "value": {"action": "prior"},
        }

    with pytest.raises(resolver.ResolutionError, match="already exists"):
        await resolver.resolve_uncertain_article(
            connection,
            target_main_sha=TARGET_MAIN_SHA,
            apply=True,
        )

    assert connection.writes == []
    assert connection.job["status"] == "uncertain"


@pytest.mark.asyncio
async def test_apply_rolls_back_audit_and_prior_updates_when_effect_cas_fails() -> None:
    from scripts import resolve_one_uncertain_article as resolver

    connection = FakeConnection()
    connection.fail_effect_cas = True

    with pytest.raises(resolver.ResolutionError, match="effect compare-and-set"):
        await resolver.resolve_uncertain_article(
            connection,
            target_main_sha=TARGET_MAIN_SHA,
            apply=True,
        )

    assert connection.job["status"] == "uncertain"
    assert connection.effect["status"] == "uncertain"
    assert connection.envelope["status"] == "uncertain"
    assert connection.dead_letters == []
    assert connection.worker_state == {}
    assert connection.writes == []


def test_cli_defaults_to_readonly_dry_run_and_reads_url_only_from_environment(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from scripts import resolve_one_uncertain_article as resolver

    database_url = "postgresql://private-user:private-pass@example.test/private-db"
    connection = FakeConnection()
    connected_urls: list[str] = []

    async def connect(value: str) -> FakeConnection:
        connected_urls.append(value)
        return connection

    monkeypatch.setattr(resolver.asyncpg, "connect", connect)
    monkeypatch.setenv("INBOX_MIGRATION_DATABASE_URL", database_url)

    exit_code = resolver.main(["--target-main-sha", TARGET_MAIN_SHA])

    output = capsys.readouterr()
    assert exit_code == 0
    assert connected_urls == [database_url]
    assert "mode=dry-run" in output.out
    assert database_url not in output.out + output.err
    assert connection.transaction_options == {"isolation": "serializable", "readonly": True}
    assert connection.writes == []


def test_cli_suppresses_driver_errors_that_might_contain_the_database_url(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from scripts import resolve_one_uncertain_article as resolver

    database_url = "postgresql://private-user:private-pass@example.test/private-db"

    async def fail_connect(value: str) -> FakeConnection:
        raise RuntimeError(f"connection failed for {value}")

    monkeypatch.setattr(resolver.asyncpg, "connect", fail_connect)
    monkeypatch.setenv("INBOX_MIGRATION_DATABASE_URL", database_url)

    exit_code = resolver.main(["--target-main-sha", TARGET_MAIN_SHA])

    output = capsys.readouterr()
    assert exit_code == 1
    assert "details suppressed" in output.err
    assert database_url not in output.out + output.err
