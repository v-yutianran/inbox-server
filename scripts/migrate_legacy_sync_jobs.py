#!/usr/bin/env python3
"""补入 D1 快照中缺失的旧 PostgreSQL 终态同步任务。"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import re
import sqlite3
import sys
import warnings
from collections.abc import Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import asyncpg

from scripts.migrate_d1_snapshot import row_digest

SCHEMA = "inbox_server"
TABLE = "sync_jobs"
EXPECTED_COUNT = 38
COLUMNS = (
    "id",
    "triggered_by",
    "status",
    "stats",
    "started_at",
    "finished_at",
    "error",
)
NOT_NULL_COLUMNS = frozenset({"id", "triggered_by", "status", "stats", "started_at"})
TEXT_COLUMNS = ("text",) * len(COLUMNS)


class MigrationError(RuntimeError):
    """迁移前置条件或数据核验失败。"""


@dataclass(frozen=True)
class LegacySyncJob:
    id: str = field(repr=False)
    triggered_by: str = field(repr=False)
    status: str = field(repr=False)
    stats: str = field(repr=False)
    started_at: datetime = field(repr=False)
    finished_at: datetime | None = field(repr=False)
    error: str | None = field(repr=False)


@dataclass(frozen=True)
class SourceContract:
    columns: tuple[str, ...]
    primary_key: tuple[str, ...]


@dataclass(frozen=True)
class TargetContract:
    columns: tuple[str, ...]
    column_types: tuple[str, ...]
    not_null: frozenset[str]
    primary_key: tuple[str, ...]
    unique_keys: tuple[tuple[str, ...], ...]
    stats_json_check: bool


@dataclass(frozen=True)
class MigrationReport:
    mode: str
    row_count: int
    before_count: int
    after_count: int
    digest: str


class Source(Protocol):
    def transaction(self) -> AbstractAsyncContextManager[Any]: ...

    async def contract(self) -> SourceContract: ...

    async def ids(self) -> list[str]: ...

    async def rows_by_ids(self, ids: list[str]) -> list[LegacySyncJob]: ...


class Target(Protocol):
    def transaction(self, *, readonly: bool) -> AbstractAsyncContextManager[Any]: ...

    async def contract(self) -> TargetContract: ...

    async def lock(self) -> None: ...

    async def row_count(self) -> int: ...

    async def existing_ids(self, ids: list[str]) -> set[str]: ...

    async def insert_rows(self, rows: list[tuple[Any, ...]]) -> None: ...

    async def rows_by_ids(self, ids: list[str]) -> list[tuple[Any, ...]]: ...


class AsyncpgSource:
    def __init__(self, connection: asyncpg.Connection) -> None:
        self.connection = connection

    def transaction(self) -> Any:
        return self.connection.transaction(isolation="repeatable_read", readonly=True)

    async def contract(self) -> SourceContract:
        columns = await self.connection.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'sync_jobs' "
            "ORDER BY ordinal_position"
        )
        primary_key = await self.connection.fetchval(
            "SELECT array_agg(a.attname ORDER BY k.ordinality) "
            "FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "JOIN pg_namespace n ON n.oid = t.relnamespace "
            "CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) "
            "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum "
            "WHERE n.nspname = 'public' AND t.relname = 'sync_jobs' AND c.contype = 'p'"
        )
        return SourceContract(
            tuple(row["column_name"] for row in columns), tuple(primary_key or ())
        )

    async def ids(self) -> list[str]:
        rows = await self.connection.fetch("SELECT id FROM public.sync_jobs")
        return [row["id"] for row in rows]

    async def rows_by_ids(self, ids: list[str]) -> list[LegacySyncJob]:
        if not ids:
            return []
        rows = await self.connection.fetch(
            "SELECT id, triggered_by, status, stats::text AS stats, started_at, "
            "finished_at, error FROM public.sync_jobs WHERE id::text = ANY($1::text[])",
            ids,
        )
        return [
            LegacySyncJob(
                id=row["id"],
                triggered_by=row["triggered_by"],
                status=row["status"],
                stats=row["stats"],
                started_at=row["started_at"],
                finished_at=row["finished_at"],
                error=row["error"],
            )
            for row in rows
        ]


def _normalize_check(value: str) -> str:
    return re.sub(r'[\s"`()\[\]]+', "", value.lower())


class AsyncpgTarget:
    def __init__(self, connection: asyncpg.Connection) -> None:
        self.connection = connection

    def transaction(self, *, readonly: bool) -> Any:
        return self.connection.transaction(isolation="serializable", readonly=readonly)

    async def contract(self) -> TargetContract:
        columns = await self.connection.fetch(
            "SELECT column_name, data_type, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
            SCHEMA,
            TABLE,
        )
        primary_key = await self.connection.fetchval(
            "SELECT array_agg(a.attname ORDER BY k.ordinality) "
            "FROM pg_constraint c "
            "JOIN pg_class t ON t.oid = c.conrelid "
            "JOIN pg_namespace n ON n.oid = t.relnamespace "
            "CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality) "
            "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum "
            "WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'p'",
            SCHEMA,
            TABLE,
        )
        unique_rows = await self.connection.fetch(
            "SELECT CASE WHEN i.indexprs IS NOT NULL "
            "THEN ARRAY['__expression_index__']::name[] "
            "ELSE array_agg(a.attname ORDER BY k.ordinality) END AS columns "
            "FROM pg_index i "
            "JOIN pg_class t ON t.oid = i.indrelid "
            "JOIN pg_namespace n ON n.oid = t.relnamespace "
            "CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) "
            "LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum "
            "WHERE n.nspname = $1 AND t.relname = $2 AND i.indisunique "
            "AND k.ordinality <= i.indnkeyatts "
            "GROUP BY i.indexrelid, i.indexprs",
            SCHEMA,
            TABLE,
        )
        checks = await self.connection.fetch(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint "
            "WHERE conrelid = to_regclass($1) AND contype = 'c'",
            f"{SCHEMA}.{TABLE}",
        )
        normalized_checks = tuple(sorted(_normalize_check(row["definition"]) for row in checks))
        return TargetContract(
            columns=tuple(row["column_name"] for row in columns),
            column_types=tuple(row["data_type"] for row in columns),
            not_null=frozenset(row["column_name"] for row in columns if row["is_nullable"] == "NO"),
            primary_key=tuple(primary_key or ()),
            unique_keys=tuple(sorted(tuple(row["columns"]) for row in unique_rows)),
            stats_json_check=normalized_checks == ("checkstatsisjson",),
        )

    async def lock(self) -> None:
        await self.connection.execute(
            f'LOCK TABLE "{SCHEMA}"."{TABLE}" IN SHARE ROW EXCLUSIVE MODE'
        )

    async def row_count(self) -> int:
        return await self.connection.fetchval(f'SELECT count(*) FROM "{SCHEMA}"."{TABLE}"')

    async def existing_ids(self, ids: list[str]) -> set[str]:
        if not ids:
            return set()
        rows = await self.connection.fetch(
            f'SELECT "id" FROM "{SCHEMA}"."{TABLE}" WHERE "id" = ANY($1::text[])', ids
        )
        return {row["id"] for row in rows}

    async def insert_rows(self, rows: list[tuple[Any, ...]]) -> None:
        if not rows:
            return
        names = ", ".join(f'"{column}"' for column in COLUMNS)
        params = ", ".join(f"${index}" for index in range(1, len(COLUMNS) + 1))
        await self.connection.executemany(
            f'INSERT INTO "{SCHEMA}"."{TABLE}" ({names}) VALUES ({params})', rows
        )

    async def rows_by_ids(self, ids: list[str]) -> list[tuple[Any, ...]]:
        if not ids:
            return []
        names = ", ".join(f'"{column}"' for column in COLUMNS)
        rows = await self.connection.fetch(
            f'SELECT {names} FROM "{SCHEMA}"."{TABLE}" WHERE "id" = ANY($1::text[])',
            ids,
        )
        return [tuple(row[name] for name in COLUMNS) for row in rows]


def _d1_ids(snapshot: sqlite3.Connection) -> set[str]:
    columns = snapshot.execute('PRAGMA table_info("sync_jobs")').fetchall()
    names = tuple(row[1] for row in columns)
    primary_key = tuple(row[1] for row in sorted((row[5], row[1]) for row in columns if row[5]))
    if "id" not in names or primary_key != ("id",):
        raise MigrationError("D1 sync_jobs primary key contract mismatch")
    count = snapshot.execute('SELECT count(*) FROM "sync_jobs"').fetchone()[0]
    values = [row[0] for row in snapshot.execute('SELECT "id" FROM "sync_jobs"')]
    if len(values) != count or any(not isinstance(value, str) or not value for value in values):
        raise MigrationError("D1 sync_jobs primary keys are invalid")
    result = set(values)
    if len(result) != count:
        raise MigrationError("D1 sync_jobs primary keys are duplicated")
    return result


def _timestamp(value: datetime | None, *, nullable: bool) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise MigrationError("legacy sync_jobs timestamp is invalid")
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _mapped_row(job: LegacySyncJob) -> tuple[Any, ...]:
    if not all(
        isinstance(value, str) and value for value in (job.id, job.triggered_by, job.status)
    ):
        raise MigrationError("legacy sync_jobs required text field is invalid")
    if job.status != "done" or job.finished_at is None:
        raise MigrationError("legacy sync_jobs candidate is not terminal")
    if not isinstance(job.stats, str):
        raise MigrationError("legacy sync_jobs stats is invalid")
    try:
        stats = json.loads(job.stats)
    except (json.JSONDecodeError, TypeError):
        raise MigrationError("legacy sync_jobs stats is invalid") from None
    if not isinstance(stats, dict):
        raise MigrationError("legacy sync_jobs stats is invalid")
    if job.error is not None and not isinstance(job.error, str):
        raise MigrationError("legacy sync_jobs error field is invalid")
    return (
        job.id,
        job.triggered_by,
        job.status,
        job.stats,
        _timestamp(job.started_at, nullable=False),
        _timestamp(job.finished_at, nullable=True),
        job.error,
    )


def _validate_target_contract(contract: TargetContract) -> None:
    expected_unique_keys = (("id",),)
    if (
        contract.columns != COLUMNS
        or contract.column_types != TEXT_COLUMNS
        or contract.not_null != NOT_NULL_COLUMNS
        or contract.primary_key != ("id",)
        or contract.unique_keys != expected_unique_keys
        or not contract.stats_json_check
    ):
        raise MigrationError("target sync_jobs contract mismatch")


async def migrate_sync_jobs(
    snapshot: sqlite3.Connection,
    source: Source,
    target: Target,
    *,
    expected_count: int = EXPECTED_COUNT,
    apply: bool = False,
) -> MigrationReport:
    """以冻结 D1 主键集筛选旧 PG 终态记录，在目标库单事务补入。"""
    if expected_count < 0:
        raise MigrationError("expected count must be non-negative")
    if not snapshot.in_transaction:
        snapshot.execute("BEGIN")
    d1_ids = _d1_ids(snapshot)
    async with source.transaction():
        source_contract = await source.contract()
        if source_contract.columns != COLUMNS or source_contract.primary_key != ("id",):
            raise MigrationError("legacy sync_jobs source contract mismatch")
        source_ids = await source.ids()
        if any(not isinstance(value, str) or not value for value in source_ids):
            raise MigrationError("legacy sync_jobs primary keys are invalid")
        if len(source_ids) != len(set(source_ids)):
            raise MigrationError("legacy sync_jobs primary keys are duplicated")
        candidate_ids = [value for value in source_ids if value not in d1_ids]
        if len(candidate_ids) != expected_count:
            raise MigrationError("legacy sync_jobs candidate count differs from expected count")
        candidate_rows = await source.rows_by_ids(candidate_ids)
        if len(candidate_rows) != len(candidate_ids) or {job.id for job in candidate_rows} != set(
            candidate_ids
        ):
            raise MigrationError("legacy sync_jobs candidate identity mismatch")
        candidates = [_mapped_row(job) for job in candidate_rows]
    ids = [row[0] for row in candidates]
    candidate_ids = set(ids)
    digest = row_digest(candidates)

    async with target.transaction(readonly=not apply):
        if apply:
            await target.lock()
        _validate_target_contract(await target.contract())
        before_count = await target.row_count()
        existing_ids = await target.existing_ids(ids)
        if existing_ids:
            if existing_ids != candidate_ids:
                raise MigrationError("target primary key conflict")
            existing_rows = await target.rows_by_ids(ids)
            if (
                len(existing_rows) != len(candidates)
                or {row[0] for row in existing_rows} != candidate_ids
                or row_digest(existing_rows) != digest
            ):
                raise MigrationError("target primary key conflict")
            return MigrationReport(
                "already-migrated", len(candidates), before_count, before_count, digest
            )
        if not apply:
            return MigrationReport("dry-run", len(candidates), before_count, before_count, digest)

        await target.insert_rows(candidates)
        imported = await target.rows_by_ids(ids)
        after_count = await target.row_count()
        if (
            len(imported) != len(candidates)
            or after_count != before_count + len(candidates)
            or row_digest(imported) != digest
        ):
            raise MigrationError("post-import sync_jobs count or content digest mismatch")
        return MigrationReport("applied", len(candidates), before_count, after_count, digest)


def _database_urls(*, prompt: bool) -> tuple[str, str]:
    if prompt:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise MigrationError("--prompt-database-urls requires an interactive TTY")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                source_url = getpass.getpass("Legacy source PostgreSQL URL: ")
                target_url = getpass.getpass("Neon target PostgreSQL URL: ")
        except (getpass.GetPassWarning, OSError):
            raise MigrationError("could not read database URLs without echo") from None
        if not source_url or not target_url:
            raise MigrationError("database URL prompt was empty")
        return source_url, target_url
    source_url = os.environ.get("INBOX_LEGACY_SOURCE_DATABASE_URL") or ""
    target_url = os.environ.get("INBOX_MIGRATION_DATABASE_URL") or ""
    if not source_url or not target_url:
        raise MigrationError("source and target database URL environment variables are required")
    return source_url, target_url


async def _run(
    snapshot_path: Path,
    *,
    source_url: str,
    target_url: str,
    expected_count: int = EXPECTED_COUNT,
    apply: bool = False,
) -> MigrationReport:
    uri = snapshot_path.resolve().as_uri() + "?mode=ro&immutable=1"
    with sqlite3.connect(uri, uri=True, isolation_level=None) as snapshot:
        snapshot.execute("PRAGMA query_only = ON")
        snapshot.execute("BEGIN")
        source_connection = await asyncpg.connect(source_url)
        try:
            target_connection = await asyncpg.connect(target_url)
        except Exception:
            await source_connection.close()
            raise
        try:
            return await migrate_sync_jobs(
                snapshot,
                AsyncpgSource(source_connection),
                AsyncpgTarget(target_connection),
                expected_count=expected_count,
                apply=apply,
            )
        finally:
            try:
                await target_connection.close()
            finally:
                await source_connection.close()


def _nonnegative_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a non-negative integer") from None
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return parsed


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="补入 D1 快照缺失的旧 PostgreSQL 终态任务。")
    parser.add_argument("snapshot", type=Path, help="冻结的 D1 SQLite 快照")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="只读核对（默认）")
    mode.add_argument("--apply", action="store_true", help="在 Neon 单事务中补入记录")
    parser.add_argument("--expected-count", type=_nonnegative_int, default=EXPECTED_COUNT)
    parser.add_argument(
        "--prompt-database-urls",
        action="store_true",
        help="通过 TTY 无回显读取旧源库与 Neon 目标库连接串",
    )
    args = parser.parse_args(argv)
    try:
        source_url, target_url = _database_urls(prompt=args.prompt_database_urls)
        report = asyncio.run(
            _run(
                args.snapshot,
                source_url=source_url,
                target_url=target_url,
                expected_count=args.expected_count,
                apply=args.apply,
            )
        )
    except Exception as error:
        print(f"legacy sync_jobs migration failed ({type(error).__name__}).", file=sys.stderr)
        return 1
    print(
        f"mode={report.mode} candidates={report.row_count} "
        f"before={report.before_count} after={report.after_count} sha256={report.digest}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
