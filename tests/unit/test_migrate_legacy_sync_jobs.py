from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import pytest

from scripts import migrate_legacy_sync_jobs as migration
from scripts.migrate_legacy_sync_jobs import (
    COLUMNS,
    EXPECTED_COUNT,
    LegacySyncJob,
    MigrationError,
    SourceContract,
    TargetContract,
    migrate_sync_jobs,
)


def _snapshot() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE sync_jobs (id TEXT PRIMARY KEY)")
    connection.executemany("INSERT INTO sync_jobs (id) VALUES (?)", [("in-d1",), ("also-in-d1",)])
    return connection


def _job(
    job_id: str,
    *,
    status: str = "done",
    finished_at: datetime | None = datetime(2026, 9, 23, 12, tzinfo=UTC),
) -> LegacySyncJob:
    return LegacySyncJob(
        id=job_id,
        triggered_by="scheduler",
        status=status,
        stats='{"sent":1}',
        started_at=datetime(2026, 9, 23, 11, tzinfo=UTC),
        finished_at=finished_at,
        error=None,
    )


class FakeSource:
    def __init__(self, rows: list[LegacySyncJob]) -> None:
        self.source_rows = rows
        self.read_ids: list[str] | None = None

    @asynccontextmanager
    async def transaction(self):
        yield

    async def contract(self) -> SourceContract:
        return SourceContract(columns=COLUMNS, primary_key=("id",))

    async def ids(self) -> list[str]:
        return [row.id for row in self.source_rows]

    async def rows_by_ids(self, ids: list[str]) -> list[LegacySyncJob]:
        self.read_ids = ids
        return [row for row in self.source_rows if row.id in ids]


class FakeTarget:
    def __init__(self, initial: list[tuple[object, ...]] | None = None) -> None:
        self.data = initial or []
        self.readonly_transactions = 0
        self.writes = 0
        self.fail_after_insert = False

    @asynccontextmanager
    async def transaction(self, *, readonly: bool):
        before = self.data.copy()
        before_writes = self.writes
        self.readonly_transactions += int(readonly)
        try:
            yield
        except Exception:
            self.data = before
            self.writes = before_writes
            raise

    async def contract(self) -> TargetContract:
        return TargetContract(
            columns=COLUMNS,
            column_types=("text",) * len(COLUMNS),
            not_null=frozenset({"id", "triggered_by", "status", "stats", "started_at"}),
            primary_key=("id",),
            unique_keys=(("id",),),
            stats_json_check=True,
        )

    async def lock(self) -> None:
        return None

    async def row_count(self) -> int:
        return len(self.data)

    async def existing_ids(self, ids: list[str]) -> set[str]:
        return {str(row[0]) for row in self.data if row[0] in ids}

    async def insert_rows(self, rows: list[tuple[object, ...]]) -> None:
        self.data.extend(rows)
        self.writes += len(rows)
        if self.fail_after_insert:
            raise RuntimeError("simulated target failure")

    async def rows_by_ids(self, ids: list[str]) -> list[tuple[object, ...]]:
        return [row for row in self.data if row[0] in ids]


@pytest.mark.asyncio
async def test_dry_run_uses_d1_primary_key_antijoin_and_never_writes() -> None:
    snapshot = _snapshot()
    source = FakeSource([_job("in-d1"), _job("legacy-only")])
    target = FakeTarget()

    report = await migrate_sync_jobs(snapshot, source, target, expected_count=1, apply=False)

    assert report.mode == "dry-run"
    assert report.row_count == 1
    assert report.before_count == report.after_count == 0
    assert target.data == []
    assert target.writes == 0
    assert target.readonly_transactions == 1
    assert source.read_ids == ["legacy-only"]


@pytest.mark.asyncio
async def test_apply_inserts_only_terminal_rows_and_verifies_full_row_digest() -> None:
    snapshot = _snapshot()
    source = FakeSource([_job("in-d1"), _job("legacy-only")])
    target = FakeTarget()

    report = await migrate_sync_jobs(snapshot, source, target, expected_count=1, apply=True)

    assert report.mode == "applied"
    assert report.row_count == 1
    assert report.before_count == 0
    assert report.after_count == 1
    assert len(report.digest) == 64
    assert target.writes == 1
    assert target.data[0][0] == "legacy-only"


@pytest.mark.asyncio
async def test_apply_reports_already_migrated_when_all_existing_rows_match() -> None:
    jobs = [_job("legacy-only"), _job("legacy-two")]
    expected_rows = [migration._mapped_row(job) for job in jobs]
    target = FakeTarget(expected_rows)

    report = await migrate_sync_jobs(
        _snapshot(), FakeSource(jobs), target, expected_count=2, apply=True
    )

    assert report.mode == "already-migrated"
    assert report.row_count == 2
    assert report.before_count == report.after_count == 2
    assert target.data == expected_rows
    assert target.writes == 0


@pytest.mark.asyncio
async def test_apply_rejects_partial_existing_rows_without_mutation() -> None:
    jobs = [_job("legacy-only"), _job("legacy-two")]
    target = FakeTarget([migration._mapped_row(jobs[0])])
    before = target.data.copy()

    with pytest.raises(MigrationError, match="target primary key conflict"):
        await migrate_sync_jobs(
            _snapshot(), FakeSource(jobs), target, expected_count=2, apply=True
        )

    assert target.data == before
    assert target.writes == 0


@pytest.mark.asyncio
async def test_apply_rejects_existing_candidate_with_different_content() -> None:
    expected_row = migration._mapped_row(_job("legacy-only"))
    target_row = (*expected_row[:3], '{"sent":2}', *expected_row[4:])
    target = FakeTarget([target_row])

    with pytest.raises(MigrationError, match="target primary key conflict"):
        await migrate_sync_jobs(
            _snapshot(), FakeSource([_job("legacy-only")]), target, expected_count=1, apply=True
        )

    assert target.data == [target_row]
    assert target.writes == 0


@pytest.mark.asyncio
async def test_dry_run_reports_matching_existing_rows_without_writing() -> None:
    jobs = [_job("legacy-only")]
    expected_rows = [migration._mapped_row(job) for job in jobs]
    target = FakeTarget(expected_rows)

    report = await migrate_sync_jobs(
        _snapshot(), FakeSource(jobs), target, expected_count=1, apply=False
    )

    assert report.mode == "already-migrated"
    assert report.before_count == report.after_count == 1
    assert target.data == expected_rows
    assert target.writes == 0
    assert target.readonly_transactions == 1


@pytest.mark.asyncio
async def test_candidate_count_mismatch_fails_closed_before_writing() -> None:
    snapshot = _snapshot()
    target = FakeTarget()
    source = FakeSource([_job("legacy-only")])

    with pytest.raises(MigrationError, match="candidate count differs"):
        await migrate_sync_jobs(
            snapshot,
            source,
            target,
            expected_count=2,
            apply=True,
        )

    assert target.writes == 0
    assert source.read_ids is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [_job("legacy-only", status="running"), _job("legacy-only", finished_at=None)],
)
async def test_nonterminal_source_rows_are_rejected_before_writing(row: LegacySyncJob) -> None:
    target = FakeTarget()

    with pytest.raises(MigrationError, match="not terminal"):
        await migrate_sync_jobs(
            _snapshot(), FakeSource([row]), target, expected_count=1, apply=True
        )

    assert target.writes == 0


@pytest.mark.asyncio
async def test_target_primary_key_conflict_fails_without_mutation() -> None:
    snapshot = _snapshot()
    target = FakeTarget([("legacy-only",)])

    with pytest.raises(MigrationError, match="target primary key conflict"):
        await migrate_sync_jobs(
            snapshot,
            FakeSource([_job("legacy-only")]),
            target,
            expected_count=1,
            apply=True,
        )

    assert target.writes == 0
    assert len(target.data) == 1


@pytest.mark.asyncio
async def test_insert_or_postwrite_failure_rolls_back_transaction() -> None:
    target = FakeTarget()
    target.fail_after_insert = True

    with pytest.raises(RuntimeError, match="simulated target failure"):
        await migrate_sync_jobs(
            _snapshot(),
            FakeSource([_job("legacy-only")]),
            target,
            expected_count=1,
            apply=True,
        )

    assert target.data == []
    assert target.writes == 0


@pytest.mark.asyncio
async def test_postwrite_content_mismatch_rolls_back_transaction() -> None:
    class CorruptTarget(FakeTarget):
        async def insert_rows(self, rows: list[tuple[object, ...]]) -> None:
            await super().insert_rows(rows)
            row = list(self.data[0])
            row[3] = '{"sent":0}'
            self.data[0] = tuple(row)

    target = CorruptTarget()

    with pytest.raises(
        MigrationError, match="post-import sync_jobs count or content digest mismatch"
    ):
        await migrate_sync_jobs(
            _snapshot(),
            FakeSource([_job("legacy-only")]),
            target,
            expected_count=1,
            apply=True,
        )

    assert target.data == []
    assert target.writes == 0


@pytest.mark.asyncio
async def test_target_contract_mismatch_fails_closed() -> None:
    class BadTarget(FakeTarget):
        async def contract(self) -> TargetContract:
            contract = await super().contract()
            return TargetContract(
                columns=contract.columns[:-1],
                column_types=contract.column_types,
                not_null=contract.not_null,
                primary_key=contract.primary_key,
                unique_keys=contract.unique_keys,
                stats_json_check=contract.stats_json_check,
            )

    target = BadTarget()

    with pytest.raises(MigrationError, match="target sync_jobs contract mismatch"):
        await migrate_sync_jobs(
            _snapshot(), FakeSource([_job("legacy-only")]), target, expected_count=1
        )

    assert target.writes == 0


def test_default_expected_count_is_frozen_at_38() -> None:
    assert EXPECTED_COUNT == 38


def test_cli_does_not_print_database_urls_or_record_content(monkeypatch, capsys) -> None:
    source_url = "postgresql://source:source-secret@legacy/db"
    target_url = "postgresql://target:target-secret@neon/db"
    monkeypatch.setenv("INBOX_LEGACY_SOURCE_DATABASE_URL", source_url)
    monkeypatch.setenv("INBOX_MIGRATION_DATABASE_URL", target_url)
    received: dict[str, object] = {}

    async def fake_run(snapshot, *, source_url: str, target_url: str, **kwargs):
        received.update(source_url=source_url, target_url=target_url, **kwargs)
        return migration.MigrationReport("dry-run", 1, 2, 2, "a" * 64)

    monkeypatch.setattr(migration, "_run", fake_run)
    assert migration.main(["frozen.sqlite"]) == 0

    output = capsys.readouterr().out
    assert received["source_url"] == source_url
    assert received["target_url"] == target_url
    assert received["expected_count"] == EXPECTED_COUNT
    assert received["apply"] is False
    for forbidden in (source_url, target_url, "legacy-only", '{"sent":1}', "secret-value"):
        assert forbidden not in output


def test_cli_suppresses_connection_and_record_values_from_errors(monkeypatch, capsys) -> None:
    forbidden = "postgresql://user:secret@host/db stats=private error=private id=private"
    monkeypatch.setenv("INBOX_LEGACY_SOURCE_DATABASE_URL", forbidden)
    monkeypatch.setenv("INBOX_MIGRATION_DATABASE_URL", "postgresql://target@host/db")

    async def failing_run(*args, **kwargs):
        raise RuntimeError(forbidden)

    monkeypatch.setattr(migration, "_run", failing_run)
    assert migration.main(["frozen.sqlite"]) == 1

    output = capsys.readouterr()
    assert forbidden not in output.out
    assert forbidden not in output.err
