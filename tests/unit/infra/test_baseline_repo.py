"""增量基准 Repository 测试（sqlite 内存）。"""

import pytest

from inboxserver.infrastructure.persistence.repositories.baseline import IncrementalBaselineRepo


@pytest.fixture
def repo(db_session):
    return IncrementalBaselineRepo(db_session)


async def test_get_known_empty_when_no_record(repo):
    assert await repo.get_known("zhihu") == set()


async def test_save_and_get(repo):
    await repo.save_known("zhihu", {"u1", "u2"})
    assert await repo.get_known("zhihu") == {"u1", "u2"}


async def test_save_overwrites(repo):
    await repo.save_known("zhihu", {"u1"})
    await repo.save_known("zhihu", {"u2"})
    assert await repo.get_known("zhihu") == {"u2"}


async def test_sources_isolated(repo):
    await repo.save_known("zhihu", {"a"})
    await repo.save_known("inoreader", {"b"})
    assert await repo.get_known("zhihu") == {"a"}
    assert await repo.get_known("inoreader") == {"b"}
