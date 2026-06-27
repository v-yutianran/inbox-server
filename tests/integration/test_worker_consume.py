"""worker consumer 测试：OK/QUOTA/FAIL→DLQ 分支（fakeredis + mock process_fn）。

consumer 是 while True 无限循环，用 asyncio.wait_for 超时取消（消费完预填条目后
dequeue 空 → sleep(60)，被 wait_for 取消），断言副作用。
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from inboxserver.domain.models import ItemKind
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository, queue_key
from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.workers.consumer import consume

_LIMITS = dict(window_count=120, window_sec=21600, daily_limit=480, interval=0.01)


@pytest.fixture
def deps(fake_redis):
    return RedisQueueRepository(fake_redis), DedupStore(fake_redis), RateGuard(fake_redis)


async def test_consume_ok_marks_done_and_daily_incr(deps):
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://a.com"})
    process_fn = AsyncMock(return_value=(True, DispatchOutcome.OK))

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            consume(ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link", **_LIMITS),
            timeout=1.0,
        )

    assert await dedup.is_done(queue_key(ItemKind.LINK), "https://a.com")
    assert await rate.daily_count(queue_key(ItemKind.LINK)) == 1


async def test_consume_fail_three_times_to_dlq(deps):
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://b.com"})
    process_fn = AsyncMock(return_value=(False, DispatchOutcome.FAIL))

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            consume(ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link", **_LIMITS),
            timeout=2.0,
        )

    assert await queue_repo.dlq_len(ItemKind.LINK) == 1


async def test_consume_quota_does_not_go_to_dlq(deps):
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://c.com"})
    process_fn = AsyncMock(return_value=(False, DispatchOutcome.QUOTA))

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            consume(ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link", **_LIMITS),
            timeout=1.5,
        )

    assert await queue_repo.dlq_len(ItemKind.LINK) == 0


async def test_consume_skips_dedup(deps):
    """已 mark_done 的 item 再次入队 → 跳过不消费。"""
    queue_repo, dedup, rate = deps
    await dedup.mark_done(queue_key(ItemKind.LINK), "https://d.com")
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://d.com"})
    process_fn = AsyncMock(return_value=(True, DispatchOutcome.OK))

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            consume(ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link", **_LIMITS),
            timeout=1.0,
        )

    process_fn.assert_not_called()  # 去重跳过，未调 process


async def test_consume_stop_event_graceful_shutdown(deps):
    """stop_event.set() → consume graceful 退出（不靠 wait_for 超时暴力取消）。

    P0-1 graceful shutdown 验证：consume 处理完 item 后，stop_event.set() →
    _interruptible_sleep 立即返回 → while 退出 → task 正常完成。
    """
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://a.com"})
    process_fn = AsyncMock(return_value=(True, DispatchOutcome.OK))
    stop_event = asyncio.Event()

    task = asyncio.create_task(
        consume(
            ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link",
            **_LIMITS, stop_event=stop_event,
        )
    )
    await asyncio.sleep(0.5)  # 让 consume 处理 item
    stop_event.set()
    await asyncio.wait_for(task, timeout=2.0)  # 应在 2s 内优雅退出
    assert task.done()
    process_fn.assert_called()  # 确实处理了 item
