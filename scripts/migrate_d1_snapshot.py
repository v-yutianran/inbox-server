#!/usr/bin/env python3
"""把冻结的 D1 SQLite 快照安全导入 Neon 的 inbox_server schema。"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import hashlib
import json
import os
import re
import sqlite3
import sys
import warnings
from collections.abc import AsyncIterator, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import asyncpg

SCHEMA = "inbox_server"
EXPECTED_TABLE_COUNT = 23
BATCH_SIZE = 500
_MODULUS = 1 << 256


class MigrationError(RuntimeError):
    """迁移前置条件或数据核验失败。"""


@dataclass(frozen=True)
class Column:
    name: str
    sqlite_type: str
    postgres_type: str = ""
    identity: bool = False
    sequence_default: bool = False


@dataclass(frozen=True)
class UniqueKey:
    columns: tuple[str, ...]
    predicate: str | None = None


@dataclass(frozen=True)
class TableResult:
    name: str
    row_count: int
    digest: str


@dataclass(frozen=True)
class MigrationReport:
    mode: str
    tables: tuple[TableResult, ...]


Manifest = dict[str, tuple[tuple[Column, ...], set[UniqueKey], int, str]]


class Target(Protocol):
    def transaction(self, *, readonly: bool) -> Any: ...

    async def tables(self, schema: str) -> Sequence[str]: ...

    async def columns(self, schema: str, table: str) -> Sequence[Column]: ...

    async def unique_keys(self, schema: str, table: str) -> set[UniqueKey]: ...

    async def row_count(self, schema: str, table: str) -> int: ...

    async def lock_tables(self, schema: str, tables: Sequence[str]) -> None: ...

    def rows(
        self, schema: str, table: str, columns: Sequence[str]
    ) -> AsyncIterator[Sequence[Any]]: ...

    async def insert_rows(
        self, schema: str, table: str, columns: Sequence[str], rows: Sequence[Sequence[Any]]
    ) -> None: ...

    async def reset_sequences(self, schema: str, table: str, columns: Sequence[Column]) -> None: ...


def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _sqlite_tables(connection: sqlite3.Connection) -> list[str]:
    return [
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite_%' "
            "AND lower(name) NOT IN ('_cf_kv', 'd1_migrations') ORDER BY name"
        )
    ]


def _sqlite_columns(connection: sqlite3.Connection, table: str) -> tuple[Column, ...]:
    rows = connection.execute(f"PRAGMA table_xinfo({_quote(table)})").fetchall()
    if any(row[6] != 0 for row in rows):
        raise MigrationError(f"table {table} uses hidden or generated SQLite columns")
    return tuple(Column(name=row[1], sqlite_type=(row[2] or "").upper()) for row in rows)


def _normalized_predicate(predicate: str | None) -> str | None:
    if predicate is None:
        return None
    value = predicate.strip()
    normalized = []
    quote = None
    pending_space = False
    index = 0
    while index < len(value):
        character = value[index]
        if quote is not None:
            normalized.append(character)
            if character == quote:
                if index + 1 < len(value) and value[index + 1] == quote:
                    normalized.append(value[index + 1])
                    index += 1
                else:
                    quote = None
        elif character.isspace():
            pending_space = True
        else:
            if (character == "-" and value[index : index + 2] == "--") or (
                character == "/" and value[index : index + 2] == "/*"
            ):
                return value
            if pending_space and normalized:
                if normalized[-1] not in "(),=" and character not in "(),=":
                    normalized.append(" ")
            pending_space = False
            if character in "'\"`[":
                quote = "]" if character == "[" else character
                normalized.append(character)
            else:
                normalized.append(character.lower())
        index += 1
    if quote is not None:
        return value
    value = "".join(normalized).strip()
    while value.startswith("(") and value.endswith(")"):
        depth = 0
        encloses_all = True
        quote = None
        index = 0
        while index < len(value):
            character = value[index]
            if quote is not None:
                if character == quote:
                    if index + 1 < len(value) and value[index + 1] == quote:
                        index += 1
                    else:
                        quote = None
            elif character in "'\"`[":
                quote = "]" if character == "[" else character
            elif character == "(":
                depth += 1
            elif character == ")":
                depth -= 1
                if depth == 0 and index != len(value) - 1:
                    encloses_all = False
                    break
            index += 1
        if not encloses_all or depth != 0:
            break
        value = value[1:-1].strip()
    return value


def _sqlite_unique_keys(connection: sqlite3.Connection, table: str) -> set[UniqueKey]:
    primary = sorted(
        (row[5], row[1])
        for row in connection.execute(f"PRAGMA table_info({_quote(table)})")
        if row[5]
    )
    keys = {UniqueKey(tuple(column for _, column in primary))} if primary else set()
    indexes = connection.execute(f"PRAGMA index_list({_quote(table)})").fetchall()
    for index in indexes:
        if not index[2]:
            continue
        name = index[1]
        details = connection.execute(f"PRAGMA index_info({_quote(name)})").fetchall()
        if not details or any(row[2] is None for row in details):
            raise MigrationError(f"table {table} has an unsupported expression unique index")
        create_sql = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", (name,)
        ).fetchone()[0]
        predicate = None
        if index[4]:
            match = re.search(r"\bWHERE\b(.+)$", create_sql or "", flags=re.IGNORECASE | re.DOTALL)
            if match is None:
                raise MigrationError(f"table {table} has an unreadable partial unique index")
            predicate = _normalized_predicate(match.group(1))
        keys.add(UniqueKey(tuple(row[2] for row in details), predicate))
    return keys


def _sqlite_affinity(declared_type: str) -> str:
    value = declared_type.upper()
    if "INT" in value:
        return "integer"
    if any(token in value for token in ("CHAR", "CLOB", "TEXT")):
        return "text"
    if "BLOB" in value or not value:
        return "blob"
    if any(token in value for token in ("REAL", "FLOA", "DOUB")):
        return "real"
    raise MigrationError(f"unsupported SQLite column type: {declared_type or '<empty>'}")


def _compatible(column: Column, table: str) -> None:
    expected = _sqlite_affinity(column.sqlite_type)
    accepted = {
        "integer": {"int2", "int4", "int8"},
        "text": {"text"},
        "blob": {"bytea"},
        "real": {"float8"},
    }[expected]
    if column.postgres_type not in accepted:
        raise MigrationError(
            f"incompatible type for {table}.{column.name}: "
            f"SQLite {expected} to PostgreSQL {column.postgres_type}"
        )


def _canonical_value(value: Any) -> Any:
    if isinstance(value, memoryview):
        value = value.tobytes()
    if isinstance(value, bytes):
        return {"$bytes": value.hex()}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "isoformat"):
        return {"$iso": value.isoformat()}
    raise MigrationError(f"unsupported database value type: {type(value).__name__}")


class _Digest:
    def __init__(self) -> None:
        self.count = 0
        self.total = 0
        self.xor = 0

    def add(self, row: Sequence[Any]) -> None:
        encoded = json.dumps(
            [_canonical_value(value) for value in row],
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        value_hash = int.from_bytes(hashlib.sha256(encoded).digest(), "big")
        self.total = (self.total + value_hash) % _MODULUS
        self.xor ^= value_hash
        self.count += 1

    def hexdigest(self) -> str:
        accumulator = (
            self.count.to_bytes(8, "big")
            + self.total.to_bytes(32, "big")
            + self.xor.to_bytes(32, "big")
        )
        return hashlib.sha256(accumulator).hexdigest()


def row_digest(rows: Iterable[Sequence[Any]]) -> str:
    """计算与数据库返回顺序无关、保留重复行和 BLOB 的内容摘要。"""
    digest = _Digest()
    for row in rows:
        digest.add(row)
    return digest.hexdigest()


async def _async_row_digest(rows: AsyncIterator[Sequence[Any]]) -> str:
    digest = _Digest()
    async for row in rows:
        digest.add(row)
    return digest.hexdigest()


def _source_rows(
    connection: sqlite3.Connection, table: str, columns: Sequence[str]
) -> Iterable[tuple[Any, ...]]:
    cursor = connection.execute(
        f"SELECT {', '.join(_quote(name) for name in columns)} FROM {_quote(table)}"
    )
    while batch := cursor.fetchmany(BATCH_SIZE):
        yield from (tuple(row) for row in batch)


def _source_manifest(connection: sqlite3.Connection) -> Manifest:
    tables = _sqlite_tables(connection)
    if len(tables) != EXPECTED_TABLE_COUNT:
        raise MigrationError(f"snapshot must contain exactly {EXPECTED_TABLE_COUNT} user tables")
    manifest = {}
    for table in tables:
        columns = _sqlite_columns(connection, table)
        if not columns:
            raise MigrationError(f"table {table} has no columns")
        digest = row_digest(_source_rows(connection, table, [column.name for column in columns]))
        count = connection.execute(f"SELECT count(*) FROM {_quote(table)}").fetchone()[0]
        manifest[table] = (columns, _sqlite_unique_keys(connection, table), count, digest)
    return manifest


async def _target_manifest(target: Target, schema: str, tables: Sequence[str]) -> Manifest:
    manifest = {}
    for table in tables:
        columns = tuple(await target.columns(schema, table))
        if not columns:
            raise MigrationError(f"target table {table} has no columns")
        for column in columns:
            if column.sqlite_type == "GENERATED":
                raise MigrationError(f"target table {table} has a generated column")
        digest = await _async_row_digest(
            target.rows(schema, table, [column.name for column in columns])
        )
        # rows() is streamed once for the digest; count separately so no row payload is retained.
        count = await target.row_count(schema, table)
        manifest[table] = (columns, await target.unique_keys(schema, table), count, digest)
    return manifest


def _validate_schema(
    source: Manifest,
    target: Manifest,
) -> None:
    if set(source) != set(target):
        raise MigrationError("source and target table names differ")
    for table, (source_columns, source_keys, _, _) in source.items():
        target_columns, target_keys, _, _ = target[table]
        if [column.name for column in source_columns] != [column.name for column in target_columns]:
            raise MigrationError(f"source and target columns differ for table {table}")
        if source_keys != target_keys:
            raise MigrationError(f"source and target unique keys differ for table {table}")
        for source_column, target_column in zip(source_columns, target_columns, strict=True):
            _compatible(
                Column(
                    source_column.name,
                    source_column.sqlite_type,
                    target_column.postgres_type,
                ),
                table,
            )


def _same_data(
    source: Manifest,
    target: Manifest,
) -> bool:
    return all(
        source[name][2:] == target[name][2:]
        for name in source
    )


def _report(mode: str, manifest: Manifest) -> MigrationReport:
    return MigrationReport(
        mode,
        tuple(
            TableResult(name, row_count, digest)
            for name, (_, _, row_count, digest) in manifest.items()
        ),
    )


async def migrate_snapshot(
    source: sqlite3.Connection, target: Target, *, apply: bool = False
) -> MigrationReport:
    """只迁移冻结 SQLite 快照；apply=False 时数据库目标只读。"""
    if not source.in_transaction:
        source.execute("BEGIN")
    source_manifest = _source_manifest(source)
    source_tables = tuple(source_manifest)
    if set(await target.tables(SCHEMA)) != set(source_tables):
        raise MigrationError("target schema must contain exactly the snapshot's 23 tables")

    async with target.transaction(readonly=not apply):
        if apply:
            await target.lock_tables(SCHEMA, source_tables)
        target_manifest = await _target_manifest(target, SCHEMA, source_tables)
        _validate_schema(source_manifest, target_manifest)
        empty = all(values[2] == 0 for values in target_manifest.values())
        if _same_data(source_manifest, target_manifest):
            return _report("already-migrated", source_manifest)
        if not empty:
            raise MigrationError("target contains different non-empty data")
        if not apply:
            return _report("dry-run", source_manifest)

        for table, (columns, _, _, _) in source_manifest.items():
            names = [column.name for column in columns]
            cursor = source.execute(
                f"SELECT {', '.join(_quote(name) for name in names)} FROM {_quote(table)}"
            )
            while batch := cursor.fetchmany(BATCH_SIZE):
                await target.insert_rows(SCHEMA, table, names, [tuple(row) for row in batch])

        imported = await _target_manifest(target, SCHEMA, source_tables)
        _validate_schema(source_manifest, imported)
        if not _same_data(source_manifest, imported):
            raise MigrationError("post-import row count or content digest mismatch")
        for table in source_tables:
            await target.reset_sequences(SCHEMA, table, await target.columns(SCHEMA, table))
        return _report("applied", source_manifest)


class AsyncpgTarget:
    def __init__(self, connection: asyncpg.Connection) -> None:
        self.connection = connection

    def transaction(self, *, readonly: bool) -> Any:
        return self.connection.transaction(isolation="serializable", readonly=readonly)

    async def tables(self, schema: str) -> Sequence[str]:
        rows = await self.connection.fetch(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            schema,
        )
        metadata = {"_cf_kv", "d1_migrations", "schema_migrations"}
        return [row["table_name"] for row in rows if row["table_name"].lower() not in metadata]

    async def columns(self, schema: str, table: str) -> Sequence[Column]:
        rows = await self.connection.fetch(
            "SELECT column_name, udt_name, is_identity, is_generated, column_default "
            "FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 "
            "ORDER BY ordinal_position",
            schema,
            table,
        )
        return [
            Column(
                name=row["column_name"],
                sqlite_type="GENERATED" if row["is_generated"] != "NEVER" else "",
                postgres_type=row["udt_name"],
                identity=row["is_identity"] == "YES",
                sequence_default="nextval(" in (row["column_default"] or ""),
            )
            for row in rows
        ]

    async def unique_keys(self, schema: str, table: str) -> set[UniqueKey]:
        rows = await self.connection.fetch(
            "SELECT array_agg(a.attname ORDER BY k.ordinality) AS columns, "
            "pg_get_expr(i.indpred, i.indrelid) AS predicate "
            "FROM pg_index i "
            "JOIN pg_class t ON t.oid = i.indrelid "
            "JOIN pg_namespace n ON n.oid = t.relnamespace "
            "CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality) "
            "JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum "
            "WHERE n.nspname = $1 AND t.relname = $2 AND i.indisunique AND i.indisvalid "
            "AND i.indexprs IS NULL AND k.ordinality <= i.indnkeyatts "
            "GROUP BY i.indexrelid, i.indpred, i.indrelid",
            schema,
            table,
        )
        return {
            UniqueKey(tuple(row["columns"]), _normalized_predicate(row["predicate"]))
            for row in rows
        }

    async def lock_tables(self, schema: str, tables: Sequence[str]) -> None:
        names = ", ".join(f"{_quote(schema)}.{_quote(table)}" for table in sorted(tables))
        await self.connection.execute(f"LOCK TABLE {names} IN ACCESS EXCLUSIVE MODE")

    async def rows(
        self, schema: str, table: str, columns: Sequence[str]
    ) -> AsyncIterator[Sequence[Any]]:
        query = (
            f"SELECT {', '.join(_quote(name) for name in columns)} "
            f"FROM {_quote(schema)}.{_quote(table)}"
        )
        async for row in self.connection.cursor(query, prefetch=BATCH_SIZE):
            yield tuple(row[name] for name in columns)

    async def row_count(self, schema: str, table: str) -> int:
        return await self.connection.fetchval(
            f"SELECT count(*) FROM {_quote(schema)}.{_quote(table)}"
        )

    async def insert_rows(
        self, schema: str, table: str, columns: Sequence[str], rows: Sequence[Sequence[Any]]
    ) -> None:
        names = ", ".join(_quote(name) for name in columns)
        params = ", ".join(f"${index}" for index in range(1, len(columns) + 1))
        query = (
            f"INSERT INTO {_quote(schema)}.{_quote(table)} ({names}) "
            f"OVERRIDING SYSTEM VALUE VALUES ({params})"
        )
        await self.connection.executemany(query, rows)

    async def reset_sequences(self, schema: str, table: str, columns: Sequence[Column]) -> None:
        relation = f"{schema}.{table}"
        for column in columns:
            if not (column.identity or column.sequence_default):
                continue
            sequence = await self.connection.fetchval(
                "SELECT pg_get_serial_sequence($1, $2)", relation, column.name
            )
            maximum = await self.connection.fetchval(
                f"SELECT max({_quote(column.name)}) FROM {_quote(schema)}.{_quote(table)}"
            )
            if sequence and maximum is not None:
                # ALTER SEQUENCE RESTART is transactional; setval() is not rolled back.
                await self.connection.execute(
                    f"ALTER SEQUENCE {sequence} RESTART WITH {int(maximum) + 1}"
                )


def _database_url(*, prompt: bool) -> str:
    if prompt:
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise MigrationError("--prompt-database-url requires an interactive TTY")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                value = getpass.getpass("Neon database URL: ")
        except (getpass.GetPassWarning, OSError) as error:
            raise MigrationError("could not read the database URL without echo") from error
        if not value:
            raise MigrationError("database URL prompt was empty")
        return value
    value = os.environ.get("INBOX_MIGRATION_DATABASE_URL")
    if not value:
        raise MigrationError("INBOX_MIGRATION_DATABASE_URL is required")
    return value


async def _run(snapshot: Path, *, apply: bool, database_url: str) -> MigrationReport:
    uri = snapshot.resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True, isolation_level=None) as source:
        source.execute("PRAGMA query_only = ON")
        source.execute("BEGIN")
        connection = await asyncpg.connect(database_url)
        try:
            return await migrate_snapshot(source, AsyncpgTarget(connection), apply=apply)
        finally:
            await connection.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "迁移冻结 D1 SQL 导出恢复得到的 SQLite 数据库文件；"
            "远程导出与 SQL 到 SQLite 的恢复转换需在脚本外完成。"
        )
    )
    parser.add_argument(
        "snapshot",
        type=Path,
        help="由冻结 D1 SQL 导出恢复得到的 SQLite 文件（脚本不负责导出或转换）",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="只读核对（默认）")
    mode.add_argument("--apply", action="store_true", help="在单个事务中导入数据")
    parser.add_argument(
        "--prompt-database-url",
        action="store_true",
        help="通过 TTY 无回显读取 Neon 连接串，优先于 INBOX_MIGRATION_DATABASE_URL",
    )
    args = parser.parse_args(argv)
    try:
        database_url = _database_url(prompt=args.prompt_database_url)
        report = asyncio.run(
            _run(args.snapshot, apply=args.apply, database_url=database_url)
        )
    except MigrationError as error:
        print(f"迁移失败：{error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"迁移失败：{type(error).__name__}", file=sys.stderr)
        return 1
    print(f"mode={report.mode} schema={SCHEMA} tables={len(report.tables)}")
    for table in report.tables:
        print(f"{table.name}: rows={table.row_count} sha256={table.digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
