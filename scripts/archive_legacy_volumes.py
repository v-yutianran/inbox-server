#!/usr/bin/env python3
"""将校验过的旧 PostgreSQL/Redis 卷 tar 原样保存在 Neon 隔离 schema。"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import hashlib
import io
import posixpath
import sys
import tarfile
import warnings
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

import asyncpg


class ArchiveError(RuntimeError):
    """归档输入或目标数据核验失败。"""


@dataclass(frozen=True)
class VolumeArchive:
    archive_name: str
    image_version: str
    archive_bytes: bytes
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class ArchiveReport:
    mode: str
    archives: tuple[VolumeArchive, ...]


class ArchiveConnection(Protocol):
    def transaction(self) -> Any: ...

    async def execute(self, query: str, *args: Any) -> str: ...

    async def fetchrow(self, query: str, *args: Any) -> Any: ...


_SOURCES = (
    ("inbox-server_pgdata", "postgres:16.14-bookworm"),
    ("inbox-server_redisdata", "redis:7.4.9-bookworm"),
)


def _safe_member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ArchiveError("unsafe tar member path")
    return path


def _validate_tar(content: bytes) -> None:
    paths: set[PurePosixPath] = set()
    symlinks: set[PurePosixPath] = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:*") as bundle:
            for member in bundle:
                path = _safe_member_path(member.name)
                if path in paths:
                    raise ArchiveError("duplicate tar member path")
                paths.add(path)
                if member.issym() or member.islnk():
                    target = PurePosixPath(member.linkname)
                    if target.is_absolute():
                        raise ArchiveError("unsafe tar link target")
                    base = path.parent if member.issym() else PurePosixPath()
                    resolved = PurePosixPath(posixpath.normpath(str(base / target)))
                    if ".." in resolved.parts:
                        raise ArchiveError("unsafe tar link target")
                    if member.issym():
                        symlinks.add(path)
                elif not (member.isfile() or member.isdir()):
                    raise ArchiveError("unsupported tar member type")
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ArchiveError("archive is not a readable tar file") from error

    if any(parent in symlinks for path in paths for parent in path.parents):
        raise ArchiveError("tar member traverses a symlink")


def read_archives(pg_tar: Path, redis_tar: Path) -> tuple[VolumeArchive, ...]:
    archives = []
    for path, (name, image_version) in zip((pg_tar, redis_tar), _SOURCES, strict=True):
        if path.is_symlink() or not path.is_file():
            raise ArchiveError("archive file is unavailable")
        content = path.read_bytes()
        _validate_tar(content)
        archives.append(
            VolumeArchive(
                archive_name=name,
                image_version=image_version,
                archive_bytes=content,
                byte_length=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
            )
        )
    return tuple(archives)


async def persist_archives(
    connection: ArchiveConnection, archives: Sequence[VolumeArchive]
) -> None:
    if tuple(archive.archive_name for archive in archives) != tuple(
        source[0] for source in _SOURCES
    ):
        raise ArchiveError("archive sources do not match the fixed source list")

    async with connection.transaction():
        for archive, (_, expected_image) in zip(archives, _SOURCES, strict=True):
            if (
                archive.image_version != expected_image
                or archive.byte_length != len(archive.archive_bytes)
                or archive.sha256 != hashlib.sha256(archive.archive_bytes).hexdigest()
            ):
                raise ArchiveError("archive metadata does not match its source bytes")
            await connection.execute(
                "INSERT INTO inbox_server_legacy.volume_archives "
                "(archive_name, image_version, byte_length, sha256, archive_bytes) "
                "VALUES ($1, $2, $3, $4, $5) ON CONFLICT (archive_name) DO NOTHING",
                archive.archive_name,
                archive.image_version,
                archive.byte_length,
                archive.sha256,
                archive.archive_bytes,
            )
            stored = await connection.fetchrow(
                "SELECT image_version, byte_length, sha256, archive_bytes "
                "FROM inbox_server_legacy.volume_archives "
                "WHERE archive_name = $1 FOR UPDATE",
                archive.archive_name,
            )
            if stored is None:
                raise ArchiveError("archive row could not be read back")
            content = bytes(stored["archive_bytes"])
            digest = hashlib.sha256(content).hexdigest()
            if (
                stored["image_version"] != archive.image_version
                or stored["byte_length"] != archive.byte_length
                or stored["sha256"] != archive.sha256
                or len(content) != archive.byte_length
                or digest != archive.sha256
                or content != archive.archive_bytes
            ):
                raise ArchiveError("archive already archived with different content or metadata")


def _database_url() -> str:
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise ArchiveError("--prompt-database-url requires an interactive TTY")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            value = getpass.getpass("Neon database URL: ")
    except (getpass.GetPassWarning, OSError) as error:
        raise ArchiveError("could not read the database URL without echo") from error
    if not value:
        raise ArchiveError("database URL prompt was empty")
    return value


async def _run(
    archives: tuple[VolumeArchive, ...], *, apply: bool, database_url: str | None = None
) -> ArchiveReport:
    if not apply:
        return ArchiveReport("dry-run", archives)
    if not database_url:
        raise ArchiveError("database URL is required for apply")
    connection = await asyncpg.connect(database_url)
    try:
        await persist_archives(connection, archives)
    finally:
        await connection.close()
    return ArchiveReport("applied", archives)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="安全归档旧 PostgreSQL 与 Redis 卷 tar")
    parser.add_argument("pg_tar", type=Path, help="只读 PostgreSQL 卷 tar")
    parser.add_argument("redis_tar", type=Path, help="只读 Redis 卷 tar")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="只读校验（默认）")
    mode.add_argument("--apply", action="store_true", help="原样归档至 Neon")
    parser.add_argument(
        "--prompt-database-url",
        action="store_true",
        help="通过 TTY 无回显读取 Neon 连接串；仅可与 --apply 同用",
    )
    args = parser.parse_args(argv)
    if args.apply != args.prompt_database_url:
        parser.error("--apply 与 --prompt-database-url 必须同时提供")
    try:
        archives = read_archives(args.pg_tar, args.redis_tar)
        database_url = _database_url() if args.apply else None
        report = asyncio.run(
            _run(archives, apply=args.apply, database_url=database_url)
        )
    except ArchiveError as error:
        print(f"归档失败：{error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"归档失败：{type(error).__name__}", file=sys.stderr)
        return 1
    print(f"mode={report.mode}")
    for archive in report.archives:
        print(f"{archive.archive_name}: bytes={archive.byte_length} sha256={archive.sha256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
