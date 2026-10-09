#!/usr/bin/env python3
"""用 Neon 当前状态重建本地 D1 SQLite 回退演练副本。"""

from __future__ import annotations

import argparse
import asyncio
import os
import shutil
import sqlite3
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import asyncpg

if __package__:
    from scripts import migrate_d1_snapshot as migration
else:
    import migrate_d1_snapshot as migration

SCHEMA = migration.SCHEMA
BATCH_SIZE = migration.BATCH_SIZE


@dataclass(frozen=True)
class _CreatedFile:
    device: int
    inode: int


def _validate_paths(snapshot: Path, output: Path) -> tuple[Path, Path]:
    try:
        source_path = snapshot.resolve(strict=True)
    except OSError as error:
        raise migration.MigrationError("snapshot is not accessible") from error
    if not source_path.is_file():
        raise migration.MigrationError("snapshot must be a regular file")

    requested_output = output.absolute()
    output_path = requested_output.resolve(strict=False)
    if source_path == output_path:
        raise migration.MigrationError("output must differ from snapshot")
    if os.path.lexists(requested_output):
        raise migration.MigrationError("output already exists")
    if not output_path.parent.is_dir():
        raise migration.MigrationError("output parent directory must already exist")
    if os.path.lexists(output_path):
        raise migration.MigrationError("output already exists")
    return source_path, output_path


def _open_snapshot(path: Path) -> sqlite3.Connection:
    uri = path.as_uri() + "?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(uri, uri=True, isolation_level=None)
        connection.execute("PRAGMA query_only = ON")
        connection.execute("BEGIN")
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity != ("ok",):
            raise migration.MigrationError("snapshot integrity_check failed")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise migration.MigrationError("snapshot foreign_key_check failed")
        return connection
    except BaseException:
        if "connection" in locals():
            connection.close()
        raise


def _copy_snapshot(snapshot: Path, output: Path) -> _CreatedFile:
    descriptor = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "wb") as destination, snapshot.open("rb") as source:
            shutil.copyfileobj(source, destination, length=1024 * 1024)
            destination.flush()
    except BaseException:
        _remove_created_file(output, _CreatedFile(identity.st_dev, identity.st_ino))
        raise
    return _CreatedFile(identity.st_dev, identity.st_ino)


def _remove_created_file(path: Path, identity: _CreatedFile) -> None:
    try:
        current = path.lstat()
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) == (identity.device, identity.inode):
        path.unlink()


def _check_database(connection: sqlite3.Connection) -> None:
    integrity = connection.execute("PRAGMA integrity_check").fetchone()
    if integrity != ("ok",):
        raise migration.MigrationError("output integrity_check failed")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise migration.MigrationError("output foreign_key_check failed")


async def _replace_business_rows(
    output: Path,
    tables: Sequence[str],
    manifest: migration.Manifest,
    target: migration.Target,
) -> migration.Manifest:
    connection = sqlite3.connect(output, isolation_level=None)
    try:
        journal_mode = connection.execute("PRAGMA journal_mode = MEMORY").fetchone()
        if journal_mode != ("memory",):
            raise migration.MigrationError("output could not use an in-memory journal")
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute("BEGIN IMMEDIATE")

        for table in tables:
            connection.execute(f"DELETE FROM {migration._quote(table)}")

        for table in tables:
            columns = manifest[table][0]
            names = [column.name for column in columns]
            quoted_names = ", ".join(migration._quote(name) for name in names)
            placeholders = ", ".join("?" for _ in names)
            insert = (
                f"INSERT INTO {migration._quote(table)} ({quoted_names}) "
                f"VALUES ({placeholders})"
            )
            batch: list[Sequence[Any]] = []
            async for row in target.rows(SCHEMA, table, names):
                batch.append(tuple(row))
                if len(batch) == BATCH_SIZE:
                    connection.executemany(insert, batch)
                    batch.clear()
            if batch:
                connection.executemany(insert, batch)

        copied_manifest = migration._source_manifest(connection)
        migration._validate_schema(copied_manifest, manifest)
        if not migration._same_data(manifest, copied_manifest):
            raise migration.MigrationError("output row count or content digest mismatch")
        _check_database(connection)
        connection.commit()
        connection.execute("PRAGMA foreign_keys = ON")
        return copied_manifest
    except BaseException:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        connection.close()


async def rehearse_rollback(
    snapshot: Path,
    output: Path,
    target: migration.Target,
    *,
    apply: bool = False,
) -> migration.MigrationReport:
    """只读核对 Neon；apply 时只新建并写入指定的本地 SQLite 副本。"""
    source_path, output_path = _validate_paths(snapshot, output)
    source = _open_snapshot(source_path)
    created: _CreatedFile | None = None
    try:
        source_manifest = migration._source_manifest(source)
        tables = tuple(source_manifest)
        async with target.transaction(readonly=True):
            target_tables = tuple(await target.tables(SCHEMA))
            if (
                len(target_tables) != migration.EXPECTED_TABLE_COUNT
                or set(target_tables) != set(tables)
            ):
                raise migration.MigrationError(
                    "target schema must contain exactly the snapshot's 23 tables"
                )
            target_manifest = await migration._target_manifest(target, SCHEMA, tables)
            migration._validate_schema(source_manifest, target_manifest)
            if not apply:
                return migration._report("dry-run", target_manifest)

            created = _copy_snapshot(source_path, output_path)
            copied_manifest = await _replace_business_rows(
                output_path, tables, target_manifest, target
            )
            if not migration._same_data(target_manifest, copied_manifest):
                raise migration.MigrationError("output row count or content digest mismatch")
            return migration._report("applied", copied_manifest)
    except BaseException:
        if created is not None:
            _remove_created_file(output_path, created)
        raise
    finally:
        source.close()


async def _run(
    snapshot: Path,
    output: Path,
    *,
    apply: bool,
    database_url: str,
) -> migration.MigrationReport:
    connection = await asyncpg.connect(database_url)
    try:
        return await rehearse_rollback(
            snapshot, output, migration.AsyncpgTarget(connection), apply=apply
        )
    finally:
        await connection.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="只读 Neon 并在指定的新本地 SQLite 文件中重建 D1 回退演练副本。"
    )
    parser.add_argument("snapshot", type=Path, help="已校验的冻结 D1 SQLite 快照")
    parser.add_argument("output", type=Path, help="必须尚不存在的本地输出文件")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="只读核对（默认）")
    mode.add_argument("--apply", action="store_true", help="创建并重建本地输出副本")
    parser.add_argument(
        "--prompt-database-url",
        action="store_true",
        help="通过 TTY 无回显读取 Neon 连接串，优先于 INBOX_MIGRATION_DATABASE_URL",
    )
    args = parser.parse_args(argv)
    try:
        database_url = migration._database_url(prompt=args.prompt_database_url)
        report = asyncio.run(
            _run(args.snapshot, args.output, apply=args.apply, database_url=database_url)
        )
    except migration.MigrationError as error:
        print(f"回退演练失败：{error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"回退演练失败：{type(error).__name__}", file=sys.stderr)
        return 1
    print(f"mode={report.mode} schema={SCHEMA} tables={len(report.tables)}")
    for table in report.tables:
        print(f"{table.name}: rows={table.row_count} sha256={table.digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
