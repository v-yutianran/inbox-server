"""去重存储测试（fakeredis）：mark/is_done/done_count。"""

import pytest

from inboxserver.infrastructure.queue.dedup_store import DedupStore


@pytest.fixture
def store(fake_redis):
    return DedupStore(fake_redis)


async def test_mark_and_is_done(store):
    assert await store.is_done("queue:link", "fp1") is False
    await store.mark_done("queue:link", "fp1")
    assert await store.is_done("queue:link", "fp1") is True


async def test_done_count_per_queue(store):
    await store.mark_done("queue:link", "a")
    await store.mark_done("queue:link", "b")
    await store.mark_done("queue:text", "c")  # 不同队列不计入 link
    assert await store.done_count("queue:link") == 2
    assert await store.done_count("queue:text") == 1
