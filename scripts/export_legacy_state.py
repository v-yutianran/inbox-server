"""从本机 Python/PostgreSQL/Redis 运行时导出稳定、可重复导入的迁移快照。"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import redis.asyncio as redis
from sqlalchemy import select

from inboxserver.config.settings import settings
from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
from inboxserver.infrastructure.persistence.db import async_session_factory
from inboxserver.infrastructure.persistence.models import (
    ArticleArchiveEvent,
    Credential,
    DidaSyncState,
    IncrementalBaseline,
    LoginSession,
    Subscription,
    SyncJob,
    TelegramOffset,
)

KINDS = ("link", "text", "file", "article")
NAMESPACE = uuid.UUID("21883817-944f-4d86-a461-8d647b664f77")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="敏感快照输出路径")
    parser.add_argument("--dry-run", action="store_true", help="只输出脱敏计数")
    args = parser.parse_args()
    if not args.dry_run and args.output is None:
        parser.error("--output is required unless --dry-run is set")
    return args


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def digest_identity(kind: str, identity: str) -> str:
    if kind == "article" and len(identity) == 64 and all(c in "0123456789abcdef" for c in identity):
        return identity
    return hashlib.sha256(identity.encode()).hexdigest()


def queue_item(kind: str, payload: dict[str, Any], exported_at: str) -> dict[str, Any]:
    if kind == "link":
        item = {
            "itemKind": "link",
            "url": payload["url"],
            "title": payload.get("title"),
            "tags": payload.get("tags") or [],
        }
        identity = str(payload["url"])
    elif kind == "text":
        item = {"itemKind": "text", "content": payload.get("content") or payload.get("text")}
        identity = str(item["content"])
    elif kind == "article":
        item = {
            "itemKind": "article",
            "url": payload["url"],
            "title": payload.get("title"),
            "tags": payload.get("tags") or [],
            "requestedAt": payload.get("requested_at") or exported_at,
        }
        identity = str(payload["url"])
    else:
        item = {
            "itemKind": "file",
            "localPath": payload["local_path"],
            "remoteName": payload["remote_name"],
        }
        identity = str(payload["remote_name"])
    item = {key: value for key, value in item.items() if value is not None}
    dedupe_key = f"dispatch:{kind}:{digest_identity(kind, identity)}"
    return {
        "schemaVersion": 1,
        "jobId": str(uuid.uuid5(NAMESPACE, dedupe_key)),
        "dedupeKey": dedupe_key,
        "createdAt": exported_at,
        "kind": "dispatch-item",
        "payload": item,
    }


async def export_postgres() -> dict[str, list[dict[str, Any]]]:
    vault = CredentialVault()
    async with async_session_factory() as session:
        telegram = list((await session.execute(select(TelegramOffset))).scalars())
        dida = list((await session.execute(select(DidaSyncState))).scalars())
        credentials = list((await session.execute(select(Credential))).scalars())
        sessions = list((await session.execute(select(LoginSession))).scalars())
        baselines = list((await session.execute(select(IncrementalBaseline))).scalars())
        sync_jobs = list((await session.execute(select(SyncJob))).scalars())
        article_events = list((await session.execute(select(ArticleArchiveEvent))).scalars())
        subscriptions = list((await session.execute(select(Subscription))).scalars())
    return {
        "telegramOffsets": [
            {
                "tokenHash": row.bot_token_hash,
                "updateId": row.update_id,
                "updatedAt": iso(row.updated_at),
            }
            for row in telegram
        ],
        "didaSyncStates": [
            {
                "tokenHash": row.token_hash,
                "savedTitles": sorted(row.saved_titles or []),
                "lastSync": iso(row.last_sync),
                "updatedAt": iso(row.updated_at),
            }
            for row in dida
        ],
        "credentials": [
            {
                "name": row.name,
                "platform": row.platform,
                "kind": row.kind,
                "payload": vault.decrypt(row.payload_encrypted),
            }
            for row in credentials
        ],
        "loginSessions": [
            {
                "platform": row.platform,
                "state": vault.decrypt(row.storage_state_encrypted),
                "status": row.status,
                "expiresAt": iso(row.expires_at),
                "lastUsedAt": iso(row.last_used_at),
                "lastError": row.last_error,
            }
            for row in sessions
        ],
        "baselines": [
            {"source": row.source, "knownKeys": sorted(row.known_keys or [])}
            for row in baselines
        ],
        "syncJobs": [
            {
                "id": row.id,
                "triggeredBy": row.triggered_by,
                "status": row.status,
                "stats": row.stats or {},
                "startedAt": iso(row.started_at),
                "finishedAt": iso(row.finished_at),
                "error": row.error,
            }
            for row in sync_jobs
        ],
        "articleEvents": [
            {
                "sourceUrl": row.source_url,
                "urlFingerprint": row.url_fingerprint,
                "title": row.title,
                "status": row.status,
                "reason": row.reason,
                "filename": row.filename,
                "occurredAt": iso(row.occurred_at),
            }
            for row in article_events
        ],
        "subscriptions": [
            {
                "id": row.id,
                "plan": row.plan,
                "status": row.status,
                "seats": row.seats,
                "currentPeriodEnd": iso(row.current_period_end),
                "createdAt": iso(row.created_at),
            }
            for row in subscriptions
        ],
    }


async def export_redis(exported_at: str) -> dict[str, list[dict[str, Any]]]:
    client = redis.from_url(settings.redis_url, decode_responses=True)
    done_jobs: list[dict[str, Any]] = []
    dead_letters: list[dict[str, Any]] = []
    pending_jobs: list[dict[str, Any]] = []
    rate_limits: list[dict[str, Any]] = []
    try:
        async for key in client.scan_iter(match="queue:*:done:*"):
            _, kind, _, identity = key.split(":", 3)
            digest = digest_identity(kind, identity)
            dedupe_key = f"dispatch:{kind}:{digest}"
            done_jobs.append(
                {
                    "dedupeKey": dedupe_key,
                    "jobId": str(uuid.uuid5(NAMESPACE, dedupe_key)),
                    "itemKind": kind,
                    "completedAt": exported_at,
                }
            )
        for kind in KINDS:
            for raw in await client.lrange(f"queue:{kind}:failed", 0, -1):
                payload = json.loads(raw)
                canonical = json.dumps(
                    payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                digest = hashlib.sha256(canonical.encode()).hexdigest()
                dead_letters.append(
                    {
                        "messageId": str(uuid.uuid5(NAMESPACE, f"dead:{kind}:{digest}")),
                        "itemKind": kind,
                        "attempts": int(payload.get("retry", 3)),
                        "errorClass": "permanent",
                        "errorMessage": "legacy dead letter",
                        "payloadDigest": digest,
                        "createdAt": exported_at,
                    }
                )
            for raw in await client.lrange(f"queue:{kind}", 0, -1):
                pending_jobs.append(queue_item(kind, json.loads(raw), exported_at))
        async for key in client.scan_iter(match="queue:*:daily:*"):
            count = int(await client.get(key) or 0)
            ttl = await client.ttl(key)
            parts = key.split(":")
            if len(parts) < 4:
                continue
            rate_limits.append(
                {
                    "scope": f"{parts[1]}:daily",
                    "bucketKey": parts[3],
                    "count": count,
                    "expiresAt": datetime.fromtimestamp(
                        datetime.now(UTC).timestamp() + max(ttl, 0), UTC
                    ).isoformat(),
                }
            )
    finally:
        await client.aclose()
    return {
        "doneJobs": sorted(done_jobs, key=lambda item: item["dedupeKey"]),
        "deadLetters": sorted(dead_letters, key=lambda item: item["messageId"]),
        "pendingJobs": sorted(pending_jobs, key=lambda item: item["dedupeKey"]),
        "rateLimits": sorted(rate_limits, key=lambda item: (item["scope"], item["bucketKey"])),
    }


async def build_snapshot() -> dict[str, Any]:
    exported_at = datetime.now(UTC).isoformat()
    postgres, redis_state = await asyncio.gather(
        export_postgres(), export_redis(exported_at)
    )
    if any(job["payload"]["itemKind"] == "file" for job in redis_state["pendingJobs"]):
        raise RuntimeError("pending_file_requires_manual_pvc_transfer")
    return {
        "schemaVersion": 1,
        "exportedAt": exported_at,
        "postgres": postgres,
        "redis": redis_state,
    }


def counts(snapshot: dict[str, Any]) -> dict[str, dict[str, int]]:
    return {
        section: {key: len(value) for key, value in payload.items()}
        for section, payload in (
            ("postgres", snapshot["postgres"]),
            ("redis", snapshot["redis"]),
        )
    }


def write_secure(path: Path, snapshot: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=".legacy-",
        suffix=".json",
    )
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(snapshot, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_name, path)
        path.chmod(0o600)
    finally:
        Path(temporary_name).unlink(missing_ok=True)


async def main() -> None:
    args = parse_args()
    snapshot = await build_snapshot()
    if not args.dry_run:
        write_secure(args.output, snapshot)
    print(
        json.dumps(
            {
                "status": "dry-run" if args.dry_run else "exported",
                "counts": counts(snapshot),
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
