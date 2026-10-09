from __future__ import annotations

import hashlib
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from scripts.migrate_d1_snapshot import Column, MigrationError, UniqueKey

try:
    from scripts.rehearse_neon_d1_rollback import rehearse_rollback
except ImportError:
    rehearse_rollback = None


def _snapshot(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        for index in range(23):
            connection.execute(
                f'CREATE TABLE "table_{index:02}" '
                "(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, blob BLOB)"
            )
            connection.execute(
                f'INSERT INTO "table_{index:02}" VALUES (?, ?, ?)',
                (index + 1, f"snapshot-{index}", bytes([index, 0, 255])),
            )
        connection.execute('CREATE TABLE "_cf_KV" (key TEXT, value BLOB)')
        connection.execute('INSERT INTO "_cf_KV" VALUES (?, ?)', ("metadata", b"kept"))
        connection.execute("CREATE TABLE d1_migrations (id TEXT)")
        connection.execute("INSERT INTO d1_migrations VALUES ('migration-1')")


def _snapshot_with_foreign_key(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            'CREATE TABLE "table_00" '
            "(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, blob BLOB)"
        )
        connection.execute('INSERT INTO "table_00" VALUES (1, ?, ?)', ("parent", b"p"))
        connection.execute(
            'CREATE TABLE "table_01" '
            "(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES table_00(id))"
        )
        connection.execute('INSERT INTO "table_01" VALUES (1, 1)')
        for index in range(2, 23):
            connection.execute(
                f'CREATE TABLE "table_{index:02}" '
                "(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, blob BLOB)"
            )
            connection.execute(
                f'INSERT INTO "table_{index:02}" VALUES (?, ?, ?)',
                (index + 1, f"snapshot-{index}", bytes([index, 0, 255])),
            )
        connection.execute('CREATE TABLE "_cf_KV" (key TEXT, value BLOB)')
        connection.execute('INSERT INTO "_cf_KV" VALUES (?, ?)', ("metadata", b"kept"))
        connection.execute("CREATE TABLE d1_migrations (id TEXT)")
        connection.execute("INSERT INTO d1_migrations VALUES ('migration-1')")


class FakeReadTarget:
    def __init__(self, snapshot: Path) -> None:
        with sqlite3.connect(snapshot) as connection:
            self.tables_by_name = {
                row[0]: None
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' "
                    "AND name NOT LIKE 'sqlite_%' "
                    "AND lower(name) NOT IN ('_cf_kv', 'd1_migrations') ORDER BY name"
                )
            }
            self.columns_by_table = {}
            self.keys_by_table = {}
            self.data = {}
            for table in self.tables_by_name:
                info = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
                self.columns_by_table[table] = tuple(
                    Column(row[1], row[2], {"INTEGER": "int8", "TEXT": "text", "BLOB": "bytea"}[row[2]])
                    for row in info
                )
                primary = sorted((row[5], row[1]) for row in info if row[5])
                self.keys_by_table[table] = (
                    {UniqueKey(tuple(name for _, name in primary))} if primary else set()
                )
                self.data[table] = [
                    tuple(row)
                    for row in connection.execute(f'SELECT * FROM "{table}"')
                ]
        self.readonly_transactions = 0
        self.rows_read = 0

    @asynccontextmanager
    async def transaction(self, *, readonly: bool):
        assert readonly is True
        self.readonly_transactions += 1
        yield

    async def tables(self, schema: str) -> list[str]:
        assert schema == "inbox_server"
        return sorted(self.tables_by_name)

    async def columns(self, schema: str, table: str) -> tuple[Column, ...]:
        assert schema == "inbox_server"
        return self.columns_by_table[table]

    async def unique_keys(self, schema: str, table: str) -> set[UniqueKey]:
        assert schema == "inbox_server"
        return self.keys_by_table[table]

    async def row_count(self, schema: str, table: str) -> int:
        assert schema == "inbox_server"
        return len(self.data[table])

    async def rows(self, schema: str, table: str, columns: list[str]):
        assert schema == "inbox_server"
        indexes = [column.name for column in self.columns_by_table[table]]
        for row in self.data[table]:
            self.rows_read += 1
            yield tuple(row[indexes.index(column)] for column in columns)


def _require_rehearsal():
    assert rehearse_rollback is not None, "rollback rehearsal API must exist"
    return rehearse_rollback


@pytest.mark.asyncio
async def test_dry_run_is_read_only_and_apply_replaces_all_business_rows(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.sqlite"
    output = tmp_path / "rehearsal.sqlite"
    _snapshot(snapshot)
    original_bytes = snapshot.read_bytes()
    target = FakeReadTarget(snapshot)
    target.data["table_00"] = [(101, "neon-only", b"new")]
    target.data["table_01"] = []
    target.data["table_02"].append((103, "new-row", b"blob"))

    dry_report = await _require_rehearsal()(snapshot, output, target, apply=False)

    assert dry_report.mode == "dry-run"
    assert not output.exists()
    assert snapshot.read_bytes() == original_bytes
    assert target.readonly_transactions == 1
    assert "neon-only" not in repr(dry_report)

    applied_report = await _require_rehearsal()(snapshot, output, target, apply=True)

    assert applied_report.mode == "applied"
    assert output.is_file()
    assert snapshot.read_bytes() == original_bytes
    assert target.readonly_transactions == 2
    with sqlite3.connect(output) as connection:
        assert connection.execute('SELECT * FROM "table_00"').fetchall() == [
            (101, "neon-only", b"new")
        ]
        assert connection.execute('SELECT * FROM "table_01"').fetchall() == []
        assert connection.execute('SELECT * FROM "table_02" ORDER BY id').fetchall()[-1] == (
            103,
            "new-row",
            b"blob",
        )
        assert connection.execute('SELECT * FROM "_cf_KV"').fetchall() == [("metadata", b"kept")]
        assert connection.execute("SELECT * FROM d1_migrations").fetchall() == [("migration-1",)]
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    assert sum(table.row_count for table in applied_report.tables) == sum(
        len(rows) for rows in target.data.values()
    )


@pytest.mark.asyncio
async def test_dry_run_rejects_existing_output_without_modifying_it(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.sqlite"
    output = tmp_path / "existing.sqlite"
    _snapshot(snapshot)
    output.write_bytes(b"preserve me")
    before = hashlib.sha256(output.read_bytes()).digest()

    with pytest.raises(MigrationError, match="output already exists"):
        await _require_rehearsal()(snapshot, output, FakeReadTarget(snapshot), apply=False)

    assert hashlib.sha256(output.read_bytes()).digest() == before


@pytest.mark.asyncio
async def test_dry_run_rejects_dangling_output_symlink(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.sqlite"
    output = tmp_path / "rehearsal.sqlite"
    destination = tmp_path / "not-created.sqlite"
    _snapshot(snapshot)
    output.symlink_to(destination)

    with pytest.raises(MigrationError, match="output already exists"):
        await _require_rehearsal()(snapshot, output, FakeReadTarget(snapshot), apply=False)

    assert output.is_symlink()
    assert not destination.exists()


@pytest.mark.asyncio
async def test_apply_rejects_snapshot_as_output(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.sqlite"
    _snapshot(snapshot)
    before = snapshot.read_bytes()

    with pytest.raises(MigrationError, match="output must differ from snapshot"):
        await _require_rehearsal()(snapshot, snapshot, FakeReadTarget(snapshot), apply=True)

    assert snapshot.read_bytes() == before


@pytest.mark.asyncio
async def test_schema_mismatch_fails_before_creating_output(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.sqlite"
    output = tmp_path / "rehearsal.sqlite"
    _snapshot(snapshot)
    target = FakeReadTarget(snapshot)
    target.columns_by_table["table_00"] = (
        Column("id", "INTEGER", "text"),
        *target.columns_by_table["table_00"][1:],
    )

    with pytest.raises(MigrationError, match="incompatible type"):
        await _require_rehearsal()(snapshot, output, target, apply=True)

    assert not output.exists()


@pytest.mark.asyncio
async def test_stream_failure_removes_only_incomplete_output(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.sqlite"
    output = tmp_path / "rehearsal.sqlite"
    _snapshot(snapshot)
    before = snapshot.read_bytes()
    target = FakeReadTarget(snapshot)

    async def failing_rows(schema: str, table: str, columns: list[str]):
        if table == "table_05":
            raise RuntimeError("synthetic stream failure")
        async for row in original_rows(schema, table, columns):
            yield row

    original_rows = target.rows
    target.rows = failing_rows

    with pytest.raises(RuntimeError, match="synthetic stream failure"):
        await _require_rehearsal()(snapshot, output, target, apply=True)

    assert not output.exists()
    assert snapshot.read_bytes() == before


@pytest.mark.asyncio
async def test_foreign_key_violation_removes_incomplete_output(tmp_path: Path) -> None:
    snapshot = tmp_path / "snapshot.sqlite"
    output = tmp_path / "rehearsal.sqlite"
    _snapshot_with_foreign_key(snapshot)
    target = FakeReadTarget(snapshot)
    target.data["table_01"] = [(1, 999)]

    with pytest.raises(MigrationError, match="output foreign_key_check failed"):
        await _require_rehearsal()(snapshot, output, target, apply=True)

    assert not output.exists()
