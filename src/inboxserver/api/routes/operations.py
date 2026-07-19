"""React 运维控制台的聚合读 API。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.api.auth import require_api_key
from inboxserver.api.deps import get_redis, get_session
from inboxserver.api.routes.channels import safe_channel_summary
from inboxserver.api.routes.queue import queue_summary
from inboxserver.config.channels import load_channels
from inboxserver.config.settings import settings
from inboxserver.infrastructure.operations.heartbeat import read_worker_heartbeat
from inboxserver.infrastructure.persistence.models import ArticleArchiveEvent, SyncJob
from inboxserver.infrastructure.persistence.repositories.article_archive_event import (
    ArticleArchiveEventRepo,
)
from inboxserver.infrastructure.persistence.repositories.sync_job import SyncJobRepo
from inboxserver.infrastructure.scheduler import SCHEDULE_INTERVAL_MINUTES

router = APIRouter(prefix="/api/operations", tags=["operations"])


def _sync_job_payload(job: SyncJob) -> dict:
    return {
        "id": job.id,
        "triggered_by": job.triggered_by,
        "status": job.status,
        "stats": job.stats,
        "started_at": job.started_at.isoformat(),
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
        "error": job.error,
    }


def _article_event_payload(event: ArticleArchiveEvent) -> dict:
    return {
        "id": event.id,
        "source_url": event.source_url,
        "url_fingerprint": event.url_fingerprint,
        "title": event.title,
        "status": event.status,
        "reason": event.reason,
        "filename": event.filename,
        "occurred_at": event.occurred_at.isoformat(),
    }


def _scheduler_payload(request: Request) -> dict:
    scheduler = getattr(request.app.state, "scheduler", None)
    job = scheduler.get_job("collect") if scheduler is not None else None
    next_run = getattr(job, "next_run_time", None)
    interval = getattr(getattr(job, "trigger", None), "interval", None)
    return {
        "enabled": bool(settings.scheduler_enabled and scheduler is not None),
        "interval_seconds": (
            int(interval.total_seconds())
            if interval is not None
            else SCHEDULE_INTERVAL_MINUTES * 60
        ),
        "next_run_at": next_run.isoformat() if next_run else None,
    }


@router.get("/overview")
async def overview(
    request: Request,
    queue_redis: Annotated[aioredis.Redis, Depends(get_redis)],
    session: Annotated[AsyncSession, Depends(get_session)],
    _: Annotated[None, Depends(require_api_key)],
) -> dict:
    heartbeat = await read_worker_heartbeat(queue_redis)
    sync_jobs = await SyncJobRepo(session).list_recent(limit=10)
    article_events = await ArticleArchiveEventRepo(session).list_recent(limit=10)
    return {
        "status": "ok",
        "generated_at": datetime.now(UTC).isoformat(),
        "server": {"online": True},
        "worker": {"online": heartbeat is not None, "last_heartbeat_at": heartbeat},
        "scheduler": _scheduler_payload(request),
        "channels": safe_channel_summary(load_channels()),
        "queues": await queue_summary(queue_redis),
        "sync_jobs": [_sync_job_payload(job) for job in sync_jobs],
        "article_events": [_article_event_payload(event) for event in article_events],
    }


@router.get("/sync-jobs")
async def sync_jobs(
    session: Annotated[AsyncSession, Depends(get_session)],
    _: Annotated[None, Depends(require_api_key)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict:
    jobs = await SyncJobRepo(session).list_recent(limit=limit)
    return {"status": "ok", "items": [_sync_job_payload(job) for job in jobs]}


@router.get("/article-events")
async def article_events(
    session: Annotated[AsyncSession, Depends(get_session)],
    _: Annotated[None, Depends(require_api_key)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict:
    events = await ArticleArchiveEventRepo(session).list_recent(limit=limit)
    return {
        "status": "ok",
        "items": [_article_event_payload(event) for event in events],
    }
