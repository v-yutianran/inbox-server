"""同步任务运行历史 Repository。"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.models import SyncJob


class SyncJobRepo:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def start(self, triggered_by: str) -> str:
        job_id = str(uuid4())
        self._session.add(SyncJob(id=job_id, triggered_by=triggered_by, status="running"))
        await self._session.commit()
        return job_id

    async def mark_done(self, job_id: str, stats: dict) -> None:
        job = await self._session.get(SyncJob, job_id)
        if job is None:
            return
        job.status = "done"
        job.stats = stats
        job.finished_at = datetime.now(UTC)
        await self._session.commit()

    async def mark_failed(self, job_id: str, error_type: str) -> None:
        job = await self._session.get(SyncJob, job_id)
        if job is None:
            return
        job.status = "failed"
        job.error = error_type
        job.finished_at = datetime.now(UTC)
        await self._session.commit()

    async def list_recent(self, *, limit: int) -> list[SyncJob]:
        result = await self._session.execute(
            select(SyncJob).order_by(SyncJob.started_at.desc()).limit(limit)
        )
        return list(result.scalars())
