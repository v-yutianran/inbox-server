"""队列 Repository 测试（fakeredis）：FIFO / requeue / DLQ / peek / 隔离 / clear。"""

import pytest

from inboxserver.domain.models import ItemKind
from inboxserver.infrastructure.queue.repository import RedisQueueRepository


@pytest.fixture
def repo(fake_redis):
    return RedisQueueRepository(fake_redis)


async def test_enqueue_dequeue_fifo(repo):
    await repo.enqueue(ItemKind.LINK, {"url": "a"})
    await repo.enqueue(ItemKind.LINK, {"url": "b"})
    assert (await repo.dequeue(ItemKind.LINK))["url"] == "a"
    assert (await repo.dequeue(ItemKind.LINK))["url"] == "b"
    assert await repo.dequeue(ItemKind.LINK) is None


async def test_requeue_defers_after_existing(repo):
    """requeue(LPUSH 头) + dequeue(RPOP 尾)：失败项排到现有项之后重试（与 inbox_queue 一致）。"""
    await repo.enqueue(ItemKind.LINK, {"url": "a"})
    await repo.enqueue(ItemKind.LINK, {"url": "b"})  # [b, a]
    item = await repo.dequeue(ItemKind.LINK)  # RPOP → a，剩 [b]
    await repo.requeue(ItemKind.LINK, item)  # LPUSH a → [a, b]
    assert (await repo.dequeue(ItemKind.LINK))["url"] == "b"  # RPOP → b（现有项先处理）
    assert (await repo.dequeue(ItemKind.LINK))["url"] == "a"  # RPOP → a（requeue 项最后重试）


async def test_move_to_dlq(repo):
    await repo.move_to_dlq(ItemKind.LINK, {"url": "x"})
    assert await repo.dlq_len(ItemKind.LINK) == 1
    assert await repo.len(ItemKind.LINK) == 0


async def test_peek_all_does_not_consume(repo):
    await repo.enqueue(ItemKind.LINK, {"url": "a"})
    await repo.enqueue(ItemKind.LINK, {"url": "b"})
    items = await repo.peek_all(ItemKind.LINK)
    assert [i["url"] for i in items] == ["b", "a"]  # lrange 头→尾
    assert await repo.len(ItemKind.LINK) == 2


async def test_kind_isolation(repo):
    await repo.enqueue(ItemKind.LINK, {"url": "a"})
    await repo.enqueue(ItemKind.TEXT, {"content": "b"})
    assert await repo.len(ItemKind.LINK) == 1
    assert await repo.len(ItemKind.TEXT) == 1


async def test_clear(repo):
    await repo.enqueue(ItemKind.LINK, {"url": "a"})
    await repo.clear(ItemKind.LINK)
    assert await repo.len(ItemKind.LINK) == 0
