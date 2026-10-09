from __future__ import annotations

import getpass
import sqlite3
from contextlib import asynccontextmanager
from io import StringIO

import pytest

from scripts import migrate_d1_snapshot as migration
from scripts.migrate_d1_snapshot import (
    Column,
    MigrationError,
    MigrationReport,
    UniqueKey,
    migrate_snapshot,
    row_digest,
)


def _snapshot(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    for index in range(23):
        table = "worker_state" if index == 0 else "credentials" if index == 1 else f"table_{index:02}"
        if table == "worker_state":
            connection.execute(
                'CREATE TABLE "worker_state" '
                "(key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)), "
                "updated_at TEXT NOT NULL)"
            )
            connection.execute(
                'INSERT INTO "worker_state" VALUES (?, ?, ?)',
                ("custom:future-plugin:arbitrary-key", '{"synthetic":true}', "2026-09-24T00:00:00Z"),
            )
            continue
        if table == "credentials":
            connection.execute(
                'CREATE TABLE "credentials" '
                "(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, "
                "platform TEXT NOT NULL, kind TEXT NOT NULL, payload_encrypted BLOB NOT NULL, "
                "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )
            connection.execute(
                'INSERT INTO "credentials" VALUES (?, ?, ?, ?, ?, ?, ?)',
                (
                    73,
                    "synthetic:credential",
                    "test",
                    "cookie",
                    b"\x00synthetic-ciphertext\xff",
                    "2026-09-24T00:00:00Z",
                    "2026-09-24T00:00:00Z",
                ),
            )
            continue
        connection.execute(
            f'CREATE TABLE "{table}" '
            "(id INTEGER PRIMARY KEY, payload TEXT NOT NULL, blob BLOB)"
        )
        connection.execute(
            f'INSERT INTO "{table}" VALUES (?, ?, ?)',
            (index + 1, f"row-{index}", bytes([index, 0, 255])),
        )
    connection.execute('CREATE TABLE "_cf_KV" (key TEXT, value BLOB)')
    connection.execute('INSERT INTO "_cf_KV" VALUES (?, ?)', ("metadata", b"ignore"))
    connection.execute("CREATE TABLE d1_migrations (id TEXT)")
    connection.execute("INSERT INTO d1_migrations VALUES ('metadata')")
    connection.commit()
    return connection


def test_row_digest_preserves_bytes_and_row_order() -> None:
    assert row_digest([(1, "x", b"\x00\xff")]) != row_digest([(1, "x", b"\x00")])
    assert row_digest([(1,), (2,)]) == row_digest([(2,), (1,)])


class FakeMigrationTarget:
    def __init__(self, source: sqlite3.Connection, fail_on_table: str | None = None) -> None:
        self.data: dict[str, list[tuple[object, ...]]] = {}
        self.columns_by_table: dict[str, tuple[Column, ...]] = {}
        self.keys_by_table: dict[str, set[UniqueKey]] = {}
        self.write_count = 0
        self.readonly_transactions = 0
        self.fail_on_table = fail_on_table
        for table in (
            row[0]
            for row in source.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name NOT LIKE 'sqlite_%' "
                "AND lower(name) NOT IN ('_cf_kv', 'd1_migrations') ORDER BY name"
            )
        ):
            info = source.execute(f'PRAGMA table_info("{table}")').fetchall()
            self.columns_by_table[table] = tuple(
                Column(
                    row[1],
                    row[2],
                    {"INTEGER": "int8", "TEXT": "text", "BLOB": "bytea"}.get(row[2], ""),
                )
                for row in info
            )
            self.data[table] = []
            self.keys_by_table[table] = set()
            pk = sorted((row[5], row[1]) for row in info if row[5])
            if pk:
                self.keys_by_table[table].add(UniqueKey(tuple(column for _, column in pk)))
            for index in source.execute(f'PRAGMA index_list("{table}")'):
                if index[2]:
                    details = source.execute(f'PRAGMA index_info("{index[1]}")').fetchall()
                    self.keys_by_table[table].add(UniqueKey(tuple(row[2] for row in details)))

    @asynccontextmanager
    async def transaction(self, *, readonly: bool):
        before = {table: rows.copy() for table, rows in self.data.items()}
        before_writes = self.write_count
        self.readonly_transactions += readonly
        try:
            yield
        except Exception:
            self.data = before
            self.write_count = before_writes
            raise

    async def tables(self, schema: str) -> list[str]:
        assert schema == "inbox_server"
        return sorted(self.data)

    async def columns(self, schema: str, table: str) -> tuple[Column, ...]:
        assert schema == "inbox_server"
        return self.columns_by_table[table]

    async def unique_keys(self, schema: str, table: str) -> set[UniqueKey]:
        assert schema == "inbox_server"
        return self.keys_by_table[table]

    async def lock_tables(self, schema: str, tables: tuple[str, ...] | list[str]) -> None:
        assert schema == "inbox_server"

    async def row_count(self, schema: str, table: str) -> int:
        assert schema == "inbox_server"
        return len(self.data[table])

    async def rows(self, schema: str, table: str, columns: list[str]):
        assert schema == "inbox_server"
        indexes = [column.name for column in self.columns_by_table[table]]
        for row in self.data[table]:
            yield tuple(row[indexes.index(name)] for name in columns)

    async def insert_rows(self, schema: str, table: str, columns: list[str], rows) -> None:
        assert schema == "inbox_server"
        if table == self.fail_on_table:
            raise RuntimeError("synthetic copy failure")
        indexes = [column.name for column in self.columns_by_table[table]]
        for row in rows:
            self.data[table].append(tuple(row[columns.index(name)] for name in indexes))
            self.write_count += 1

    async def reset_sequences(self, schema: str, table: str, columns: tuple[Column, ...]) -> None:
        assert schema == "inbox_server"


@pytest.mark.asyncio
async def test_snapshot_dry_run_apply_idempotence_and_changed_data_rejection(tmp_path) -> None:
    source = _snapshot(str(tmp_path / "frozen.sqlite"))
    target = FakeMigrationTarget(source)

    report = await migrate_snapshot(source, target, apply=False)
    assert report.mode == "dry-run"
    assert sum(table.row_count for table in report.tables) == 23
    assert target.write_count == 0
    assert target.readonly_transactions == 1

    applied = await migrate_snapshot(source, target, apply=True)
    assert applied.mode == "applied"
    assert target.write_count == 23
    assert all(len(rows) == 1 for rows in target.data.values())

    repeated = await migrate_snapshot(source, target, apply=True)
    assert repeated.mode == "already-migrated"
    assert target.write_count == 23

    source.execute('UPDATE "worker_state" SET value = ?', ('"different"',))
    source.commit()
    with pytest.raises(MigrationError, match="different non-empty data"):
        await migrate_snapshot(source, target, apply=True)


@pytest.mark.asyncio
async def test_snapshot_import_preserves_arbitrary_worker_state_key_and_ciphertext(tmp_path) -> None:
    source = _snapshot(str(tmp_path / "frozen.sqlite"))
    state_row = source.execute(
        "SELECT * FROM worker_state WHERE key = ?",
        ("custom:future-plugin:arbitrary-key",),
    ).fetchone()
    credential_row = source.execute("SELECT * FROM credentials WHERE id = ?", (73,)).fetchone()
    target = FakeMigrationTarget(source)

    report = await migrate_snapshot(source, target, apply=True)

    assert report.mode == "applied"
    assert target.data["worker_state"] == [state_row]
    assert target.data["credentials"] == [credential_row]


@pytest.mark.asyncio
async def test_unique_key_mismatch_is_rejected_before_writing(tmp_path) -> None:
    source = _snapshot(str(tmp_path / "frozen.sqlite"))
    target = FakeMigrationTarget(source)
    target.keys_by_table["worker_state"].clear()

    with pytest.raises(MigrationError, match="unique keys differ"):
        await migrate_snapshot(source, target, apply=True)

    assert target.write_count == 0


@pytest.mark.asyncio
async def test_target_table_list_ignores_version_metadata_only() -> None:
    class CatalogConnection:
        async def fetch(self, query: str, schema: str):
            assert "information_schema.tables" in query
            assert schema == "inbox_server"
            return [
                {"table_name": name}
                for name in [*(f"table_{index:02}" for index in range(23)), "schema_migrations"]
            ]

    target = migration.AsyncpgTarget(CatalogConnection())

    assert await target.tables("inbox_server") == [f"table_{index:02}" for index in range(23)]


@pytest.mark.asyncio
async def test_target_with_unexpected_business_table_is_rejected_before_writing(tmp_path) -> None:
    source = _snapshot(str(tmp_path / "frozen.sqlite"))
    target = FakeMigrationTarget(source)
    target.data["unexpected_business_table"] = []

    with pytest.raises(MigrationError, match="exactly the snapshot's 23 tables"):
        await migrate_snapshot(source, target, apply=True)

    assert target.write_count == 0


@pytest.mark.asyncio
async def test_failed_import_rolls_back_every_table(tmp_path) -> None:
    source = _snapshot(str(tmp_path / "frozen.sqlite"))
    target = FakeMigrationTarget(source, fail_on_table="table_12")

    with pytest.raises(RuntimeError, match="synthetic copy failure"):
        await migrate_snapshot(source, target, apply=True)

    assert all(rows == [] for rows in target.data.values())
    assert target.write_count == 0


def test_prompt_database_url_is_hidden_and_takes_precedence(monkeypatch, capsys) -> None:
    class Tty(StringIO):
        def isatty(self) -> bool:
            return True

    secret = "postgresql://user:secret@host/db"
    stderr = Tty()
    monkeypatch.setattr(migration.sys, "stdin", Tty())
    monkeypatch.setattr(migration.sys, "stderr", stderr)
    monkeypatch.setenv("INBOX_MIGRATION_DATABASE_URL", "postgresql://env-secret")
    monkeypatch.setattr(getpass, "getpass", lambda prompt: secret)
    received = {}

    async def fake_run(snapshot, *, apply: bool, database_url: str) -> MigrationReport:
        received.update(snapshot=snapshot, apply=apply, database_url=database_url)
        return MigrationReport("dry-run", ())

    monkeypatch.setattr(migration, "_run", fake_run)
    assert migration.main(["--prompt-database-url", "frozen.sqlite"]) == 0

    assert received["database_url"] == secret
    assert received["apply"] is False
    assert secret not in capsys.readouterr().out
    assert secret not in stderr.getvalue()


def test_prompt_database_url_rejects_non_tty_even_when_env_is_set(monkeypatch, capsys) -> None:
    class NonTty(StringIO):
        def isatty(self) -> bool:
            return False

    monkeypatch.setattr(migration.sys, "stdin", NonTty())
    monkeypatch.setenv("INBOX_MIGRATION_DATABASE_URL", "postgresql://env-secret")
    monkeypatch.setattr(getpass, "getpass", lambda prompt: pytest.fail("must not prompt"))
    monkeypatch.setattr(
        migration,
        "_run",
        lambda *args, **kwargs: pytest.fail("must not connect"),
    )

    assert migration.main(["--prompt-database-url", "frozen.sqlite"]) == 1
    assert "TTY" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_partial_unique_predicate_literal_whitespace_mismatch_is_rejected(tmp_path) -> None:
    source = _snapshot(str(tmp_path / "frozen.sqlite"))
    source.execute(
        "CREATE UNIQUE INDEX table_02_payload_partial_uq "
        "ON table_02(payload) WHERE payload = 'a b'"
    )
    source.commit()
    target = FakeMigrationTarget(source)
    target.keys_by_table["table_02"].discard(UniqueKey(("payload",)))
    target.keys_by_table["table_02"].add(
        UniqueKey(("payload",), migration._normalized_predicate("payload = 'ab'"))
    )

    with pytest.raises(MigrationError, match="unique keys differ for table table_02"):
        await migrate_snapshot(source, target, apply=True)

    assert target.write_count == 0


def test_normalized_predicate_preserves_quoted_sql_content() -> None:
    assert migration._normalized_predicate("VALUE = 'a b'") == migration._normalized_predicate(
        "value='a b'"
    )
    assert migration._normalized_predicate("value = 'a b'") != migration._normalized_predicate(
        "value='ab'"
    )
    assert migration._normalized_predicate("value = 'A'") != migration._normalized_predicate(
        "value = 'a'"
    )
    assert migration._normalized_predicate('"Future Field" = 1') != migration._normalized_predicate(
        '"FutureField"=1'
    )
    assert migration._normalized_predicate("(value = '(') OR (other = 1)") == "(value='(')or(other=1)"
    assert migration._normalized_predicate("value = 1 -- note\nAND flag = 1") != migration._normalized_predicate(
        "value = 1 -- note AND flag = 1"
    )
