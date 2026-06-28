"""worker consumer 测试：OK/QUOTA/FAIL→DLQ 分支（fakeredis + mock process_fn）。

consumer 是 while 循环，用 stop_event 优雅停止（P2-8）：启动后等副作用发生，
stop_event.set() 让 consume 处理完当前 item 后自然退出，替代 asyncio.wait_for
超时暴力取消（避免 in-flight item 被半处理）。
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from inboxserver.domain.models import ItemKind, QueueLimits
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository, queue_key
from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.workers.consumer import consume

# 限速配置：窗口/日限额拉满（测试不触发限速），interval 极小（快速循环）
_LIMITS = QueueLimits(window_count=120, window_sec=21600, daily_limit=480, interval=0.01)


@pytest.fixture
def deps(fake_redis):
    return RedisQueueRepository(fake_redis), DedupStore(fake_redis), RateGuard(fake_redis)


async def _run_until_stopped(make_consume, *, settle_sec: float = 0.5) -> None:
    """以 stop_event 模式跑 consume：启动 → 等 settle_sec 让副作用发生 → 优雅停止。

    P2-8：替代 `asyncio.wait_for(consume(...), timeout)` 超时暴力取消——后者取消时
    in-flight item 可能被半处理；stop_event.set() 让 consume 在 while 循环顶部检查后
    自然退出，行为确定。settle_sec 需足够长以让目标副作用（OK/重试/配额）完成。
    """

    stop_event = asyncio.Event()
    task = asyncio.create_task(make_consume(stop_event))
    await asyncio.sleep(settle_sec)
    stop_event.set()
    await asyncio.wait_for(task, timeout=2.0)


async def test_consume_ok_marks_done_and_daily_incr(deps):
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://a.com"})
    process_fn = AsyncMock(return_value=(True, DispatchOutcome.OK))

    await _run_until_stopped(
        lambda ev: consume(
            ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link",
            limits=_LIMITS, stop_event=ev,
        )
    )

    assert await dedup.is_done(queue_key(ItemKind.LINK), "https://a.com")
    assert await rate.daily_count(queue_key(ItemKind.LINK)) == 1


async def test_consume_fail_three_times_to_dlq(deps):
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://b.com"})
    process_fn = AsyncMock(return_value=(False, DispatchOutcome.FAIL))

    # 失败 3 次才进 DLQ，需更长 settle 让多次重试循环完成（interval=0.01 极快）
    await _run_until_stopped(
        lambda ev: consume(
            ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link",
            limits=_LIMITS, stop_event=ev,
        ),
        settle_sec=1.0,
    )

    assert await queue_repo.dlq_len(ItemKind.LINK) == 1


async def test_consume_quota_does_not_go_to_dlq(deps):
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://c.com"})
    process_fn = AsyncMock(return_value=(False, DispatchOutcome.QUOTA))

    await _run_until_stopped(
        lambda ev: consume(
            ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link",
            limits=_LIMITS, stop_event=ev,
        )
    )

    assert await queue_repo.dlq_len(ItemKind.LINK) == 0


async def test_consume_skips_dedup(deps):
    """已 mark_done 的 item 再次入队 → 跳过不消费。"""
    queue_repo, dedup, rate = deps
    await dedup.mark_done(queue_key(ItemKind.LINK), "https://d.com")
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://d.com"})
    process_fn = AsyncMock(return_value=(True, DispatchOutcome.OK))

    await _run_until_stopped(
        lambda ev: consume(
            ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link",
            limits=_LIMITS, stop_event=ev,
        )
    )

    process_fn.assert_not_called()  # 去重跳过，未调 process


async def test_consume_stop_event_graceful_shutdown(deps):
    """stop_event.set() → consume graceful 退出（不靠 wait_for 超时暴力取消）。

    P0-1 graceful shutdown 验证：consume 处理完 item 后，stop_event.set() →
    _interruptible_sleep 立即返回 → while 退出 → task 正常完成。
    特意不用 _run_until_stopped helper，以精确表达「set 后处理完当前 item 即退出」的时序。
    """
    queue_repo, dedup, rate = deps
    await queue_repo.enqueue(ItemKind.LINK, {"url": "https://a.com"})
    process_fn = AsyncMock(return_value=(True, DispatchOutcome.OK))
    stop_event = asyncio.Event()

    task = asyncio.create_task(
        consume(
            ItemKind.LINK, queue_repo, dedup, rate, process_fn, "link",
            limits=_LIMITS, stop_event=stop_event,
        )
    )
    await asyncio.sleep(0.5)  # 让 consume 处理 item
    stop_event.set()
    await asyncio.wait_for(task, timeout=2.0)  # 应在 2s 内优雅退出
    assert task.done()
    process_fn.assert_called()  # 确实处理了 item
