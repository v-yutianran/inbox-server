from __future__ import annotations

import hashlib
import io
import os
import tarfile
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from scripts import archive_legacy_volumes as archive


def _tar(path, name: str, payload: bytes = b"synthetic-volume") -> None:
    with tarfile.open(path, "w") as bundle:
        entry = tarfile.TarInfo(name)
        entry.size = len(payload)
        bundle.addfile(entry, io.BytesIO(payload))


class FakeArchiveConnection:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, object]] = {}
        self.transactions = 0
        self.closed = False

    @asynccontextmanager
    async def transaction(self):
        before = self.rows.copy()
        self.transactions += 1
        try:
            yield
        except Exception:
            self.rows = before
            raise

    async def execute(self, query: str, *args):
        assert "INSERT INTO inbox_server_legacy.volume_archives" in query
        name, image_version, byte_length, digest, content = args
        self.rows.setdefault(
            name,
            {
                "archive_name": name,
                "image_version": image_version,
                "byte_length": byte_length,
                "sha256": digest,
                "archive_bytes": content,
            },
        )

    async def fetchrow(self, query: str, name: str):
        assert "FROM inbox_server_legacy.volume_archives" in query
        return self.rows.get(name)

    async def close(self) -> None:
        self.closed = True


def test_default_run_is_read_only_and_uses_fixed_sources(tmp_path, monkeypatch, capsys) -> None:
    pg_tar = tmp_path / "pg.tar"
    redis_tar = tmp_path / "redis.tar"
    _tar(pg_tar, "./PG_VERSION", b"16")
    _tar(redis_tar, "./dump.rdb", b"redis")

    async def unexpected_connect(*args, **kwargs):
        pytest.fail("dry-run must not connect to PostgreSQL")

    monkeypatch.setattr(archive.asyncpg, "connect", unexpected_connect)

    assert archive.main([str(pg_tar), str(redis_tar)]) == 0
    output = capsys.readouterr().out
    assert "inbox-server_pgdata" in output
    assert "inbox-server_redisdata" in output
    assert "mode=dry-run" in output


def test_tar_path_traversal_is_rejected(tmp_path) -> None:
    unsafe = tmp_path / "unsafe.tar"
    safe = tmp_path / "safe.tar"
    _tar(unsafe, "../outside", b"synthetic")
    _tar(safe, "./dump.rdb")

    with pytest.raises(archive.ArchiveError, match="unsafe tar member path"):
        archive.read_archives(unsafe, safe)


@pytest.mark.asyncio
async def test_same_snapshot_is_idempotent_and_verifies_readback(tmp_path) -> None:
    pg_tar = tmp_path / "pg.tar"
    redis_tar = tmp_path / "redis.tar"
    _tar(pg_tar, "./PG_VERSION", b"16")
    _tar(redis_tar, "./dump.rdb", b"redis")
    archives = archive.read_archives(pg_tar, redis_tar)
    target = FakeArchiveConnection()

    await archive.persist_archives(target, archives)
    saved = target.rows.copy()
    await archive.persist_archives(target, archives)

    assert target.rows == saved
    assert target.transactions == 2
    for item in archives:
        stored = target.rows[item.archive_name]
        assert stored["archive_bytes"] == item.archive_bytes
        assert hashlib.sha256(stored["archive_bytes"]).hexdigest() == item.sha256


@pytest.mark.asyncio
async def test_changed_content_or_metadata_is_rejected_atomically(tmp_path) -> None:
    pg_tar = tmp_path / "pg.tar"
    redis_tar = tmp_path / "redis.tar"
    _tar(pg_tar, "./PG_VERSION", b"16")
    _tar(redis_tar, "./dump.rdb", b"redis")
    original = archive.read_archives(pg_tar, redis_tar)
    target = FakeArchiveConnection()
    await archive.persist_archives(target, original)
    before = target.rows.copy()

    changed_content = tmp_path / "changed.tar"
    _tar(changed_content, "./PG_VERSION", b"different")
    changed = archive.read_archives(changed_content, redis_tar)
    with pytest.raises(archive.ArchiveError, match="already archived with different"):
        await archive.persist_archives(target, changed)
    assert target.rows == before

    changed_metadata = (replace(original[0], image_version="postgres:other"), original[1])
    with pytest.raises(archive.ArchiveError, match="metadata"):
        await archive.persist_archives(target, changed_metadata)
    assert target.rows == before


def test_tar_with_absolute_path_is_rejected(tmp_path) -> None:
    absolute = tmp_path / "absolute.tar"
    safe = tmp_path / "safe.tar"
    _tar(absolute, "/outside", b"synthetic")
    _tar(safe, "./dump.rdb")

    with pytest.raises(archive.ArchiveError, match="unsafe tar member path"):
        archive.read_archives(absolute, safe)


def test_apply_reads_database_url_without_echoing_it(tmp_path, monkeypatch, capsys) -> None:
    class Tty(io.StringIO):
        def isatty(self) -> bool:
            return True

    pg_tar = tmp_path / "pg.tar"
    redis_tar = tmp_path / "redis.tar"
    _tar(pg_tar, "./PG_VERSION", b"16")
    _tar(redis_tar, "./dump.rdb", b"redis")
    connection = FakeArchiveConnection()
    database_url = "postgresql://synthetic:synthetic-password@127.0.0.1/test_db"
    stderr = Tty()
    monkeypatch.setattr(archive.sys, "stdin", Tty())
    monkeypatch.setattr(archive.sys, "stderr", stderr)
    monkeypatch.setattr(archive.getpass, "getpass", lambda _: database_url)

    async def fake_connect(value: str):
        assert value == database_url
        return connection

    monkeypatch.setattr(archive.asyncpg, "connect", fake_connect)

    assert archive.main(
        ["--apply", "--prompt-database-url", str(pg_tar), str(redis_tar)]
    ) == 0
    output = capsys.readouterr().out
    assert database_url not in output
    assert database_url not in stderr.getvalue()
    assert connection.closed


@pytest.mark.asyncio
async def test_local_postgres_roundtrip_idempotence_and_transaction_rollback(tmp_path) -> None:
    database_url = os.environ.get("INBOX_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("INBOX_TEST_POSTGRES_URL is not set")
    parsed = urlsplit(database_url)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or "test" not in parsed.path.lower():
        raise AssertionError("INBOX_TEST_POSTGRES_URL must target a local test database")

    connection = await archive.asyncpg.connect(database_url)
    names = [source[0] for source in archive._SOURCES]
    owns_rows = False
    try:
        version = await connection.fetchval("SELECT current_setting('server_version_num')::int")
        assert version == 170006
        migration_sql = (
            Path(__file__).resolve().parents[2]
            / "apps/api/postgres-migrations/0002_legacy_archive.sql"
        ).read_text()
        await connection.execute(migration_sql)
        preexisting = await connection.fetchval(
            "SELECT count(*) FROM inbox_server_legacy.volume_archives "
            "WHERE archive_name = ANY($1::text[])",
            names,
        )
        if preexisting:
            pytest.skip("fixed archive names already exist in the local test database")
        owns_rows = True

        pg_tar = tmp_path / "pg.tar"
        redis_tar = tmp_path / "redis.tar"
        old_redis_tar = tmp_path / "redis-old.tar"
        _tar(pg_tar, "./PG_VERSION", b"16")
        _tar(redis_tar, "./dump.rdb", b"redis-current")
        _tar(old_redis_tar, "./dump.rdb", b"redis-before")
        current = archive.read_archives(pg_tar, redis_tar)
        previous_redis = archive.read_archives(pg_tar, old_redis_tar)[1]
        await connection.execute(
            "INSERT INTO inbox_server_legacy.volume_archives "
            "(archive_name, image_version, byte_length, sha256, archive_bytes) "
            "VALUES ($1, $2, $3, $4, $5)",
            previous_redis.archive_name,
            previous_redis.image_version,
            previous_redis.byte_length,
            previous_redis.sha256,
            previous_redis.archive_bytes,
        )

        with pytest.raises(archive.ArchiveError, match="different content"):
            await archive.persist_archives(connection, current)
        after_rollback = await connection.fetch(
            "SELECT archive_name FROM inbox_server_legacy.volume_archives "
            "WHERE archive_name = ANY($1::text[]) ORDER BY archive_name",
            names,
        )
        assert [row["archive_name"] for row in after_rollback] == [names[1]]

        await connection.execute(
            "DELETE FROM inbox_server_legacy.volume_archives WHERE archive_name = $1",
            names[1],
        )
        await archive.persist_archives(connection, current)
        await archive.persist_archives(connection, current)
        readback = await connection.fetch(
            "SELECT archive_name, image_version, byte_length, sha256, archive_bytes "
            "FROM inbox_server_legacy.volume_archives "
            "WHERE archive_name = ANY($1::text[]) ORDER BY archive_name",
            names,
        )
        assert len(readback) == 2
        for row, item in zip(readback, current, strict=True):
            content = bytes(row["archive_bytes"])
            assert row["archive_name"] == item.archive_name
            assert row["image_version"] == item.image_version
            assert row["byte_length"] == len(content) == item.byte_length
            assert row["sha256"] == hashlib.sha256(content).hexdigest() == item.sha256
            assert content == item.archive_bytes
    finally:
        if owns_rows:
            await connection.execute(
                "DELETE FROM inbox_server_legacy.volume_archives WHERE archive_name = ANY($1::text[])",
                names,
            )
        await connection.close()
