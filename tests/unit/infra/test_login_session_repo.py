"""登录会话 Repository 测试（sqlite 内存）。"""

from datetime import UTC, datetime, timedelta

import pytest

from inboxserver.infrastructure.persistence.repositories.login_session import LoginSessionRepo


@pytest.fixture
def repo(db_session):
    return LoginSessionRepo(db_session)


async def test_upsert_and_get(repo):
    expires = datetime.now(UTC) + timedelta(days=7)
    await repo.upsert("zhihu", b"encrypted-state", "active", expires)
    row = await repo.get("zhihu")
    assert row is not None
    assert row.status == "active"
    assert row.storage_state_encrypted == b"encrypted-state"


async def test_upsert_overwrites_existing(repo):
    expires = datetime.now(UTC) + timedelta(days=7)
    await repo.upsert("zhihu", b"old", "active", expires)
    await repo.upsert("zhihu", b"new", "active", expires)
    assert (await repo.get("zhihu")).storage_state_encrypted == b"new"


async def test_mark_status_records_error(repo):
    expires = datetime.now(UTC) + timedelta(days=7)
    await repo.upsert("zhihu", b"x", "active", expires)
    await repo.mark_status("zhihu", "expired", last_error="401 unauthorized")
    row = await repo.get("zhihu")
    assert row.status == "expired"
    assert row.last_error == "401 unauthorized"


async def test_get_missing_returns_none(repo):
    assert await repo.get("nope") is None
