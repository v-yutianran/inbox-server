"""同步运行记录：通过公开 Repository 与追踪函数验证持久化行为。"""

from __future__ import annotations

import pytest

from inboxserver.infrastructure.collectors.run_tracking import run_tracked_collect
from inboxserver.infrastructure.persistence.repositories.sync_job import SyncJobRepo


async def test_tracked_collect_persists_success(db_session):
    async def collect() -> dict:
        return {"telegram": {"enqueued": 2}}

    result = await run_tracked_collect(db_session, "manual", collect)
    jobs = await SyncJobRepo(db_session).list_recent(limit=5)

    assert result == {"telegram": {"enqueued": 2}}
    assert len(jobs) == 1
    assert jobs[0].triggered_by == "manual"
    assert jobs[0].status == "done"
    assert jobs[0].stats == {"telegram": {"enqueued": 2}}
    assert jobs[0].finished_at is not None


async def test_tracked_collect_persists_safe_failure(db_session):
    async def collect() -> dict:
        raise ValueError("secret payload must not be stored")

    with pytest.raises(ValueError, match="secret payload"):
        await run_tracked_collect(db_session, "scheduler", collect)

    jobs = await SyncJobRepo(db_session).list_recent(limit=5)
    assert len(jobs) == 1
    assert jobs[0].status == "failed"
    assert jobs[0].error == "ValueError"
    assert "secret payload" not in jobs[0].error
