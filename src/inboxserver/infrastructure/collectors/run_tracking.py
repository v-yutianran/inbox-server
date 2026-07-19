"""同步运行记录包装器；记录失败不得影响采集主流程。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.repositories.sync_job import SyncJobRepo

log = structlog.get_logger(__name__)


async def run_tracked_collect(
    session: AsyncSession,
    triggered_by: str,
    collect: Callable[[], Awaitable[dict]],
) -> dict:
    """执行一次采集并尽力持久化终态，错误内容仅保留异常类型。"""
    repo = SyncJobRepo(session)
    job_id: str | None = None
    try:
        job_id = await repo.start(triggered_by)
    except Exception as error:
        await session.rollback()
        log.warning("sync_job_record_failed", phase="start", error_type=type(error).__name__)

    try:
        result = await collect()
    except Exception as error:
        if job_id is not None:
            try:
                await repo.mark_failed(job_id, type(error).__name__)
            except Exception as record_error:
                await session.rollback()
                log.warning(
                    "sync_job_record_failed",
                    phase="failed",
                    error_type=type(record_error).__name__,
                )
        raise

    if job_id is not None:
        try:
            await repo.mark_done(job_id, result)
        except Exception as error:
            await session.rollback()
            log.warning("sync_job_record_failed", phase="done", error_type=type(error).__name__)
    return result
