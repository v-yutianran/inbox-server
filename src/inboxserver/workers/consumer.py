"""通用消费循环：限速 / 去重 / 重试 / DLQ（async，基于 domain.policy + queue repos）。

移植 worker.py consume。process_fn(item) -> (ok, DispatchOutcome)。
"""

from __future__ import annotations

import asyncio

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.dedup import fingerprint
from inboxserver.domain.policy.retry import RetryAction, decide_on_failure
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository, queue_key
from inboxserver.plugins.contracts import DispatchOutcome


async def consume(
    kind: ItemKind,
    queue_repo: RedisQueueRepository,
    dedup_store: DedupStore,
    rate_guard: RateGuard,
    process_fn,
    name: str,
    *,
    window_count: int,
    window_sec: int,
    daily_limit: int | None,
    interval: float,
) -> None:
    """通用消费循环。

    流程：每日限额→dequeue→去重→窗口限速→process→OK(mark_done+daily_incr)/QUOTA(requeue停)/FAIL(retry/DLQ)。
    """
    qkey = queue_key(kind)
    while True:
        # 每日限额：满则停等明天（不消费、不 DLQ）
        if daily_limit is not None and await rate_guard.daily_count(qkey) >= daily_limit:
            await asyncio.sleep(1800)
            continue
        item = await queue_repo.dequeue(kind)
        if not item:
            await asyncio.sleep(60)  # 队列空，1 分钟后再查
            continue
        # 成功去重：已处理跳过
        fp = fingerprint(item, kind)
        if await dedup_store.is_done(qkey, fp):
            continue
        # 窗口限速：满则回队尾等下个窗口
        if not await rate_guard.token_acquire(qkey, window_count, window_sec):
            await queue_repo.requeue(kind, item)
            await asyncio.sleep(300)
            continue
        # 处理
        try:
            _ok, outcome = await process_fn(item)
            if outcome is DispatchOutcome.OK:
                await dedup_store.mark_done(qkey, fp)
                await rate_guard.daily_incr(qkey)
            elif outcome is DispatchOutcome.QUOTA:
                # 配额超：回队首不计 retry，停队列等明天（不进 DLQ）
                await queue_repo.requeue(kind, item)
                await asyncio.sleep(1800)
                continue
            else:  # FAIL
                await _handle_fail(kind, queue_repo, item)
        except Exception:
            await _handle_fail(kind, queue_repo, item)
        await asyncio.sleep(interval)


async def _handle_fail(kind: ItemKind, queue_repo: RedisQueueRepository, item: dict) -> None:
    """失败/异常：retry+1，满 MAX_RETRY 进 DLQ，否则回队尾重试。"""
    d = decide_on_failure(item.get("retry", 0))
    item["retry"] = d.retry
    if d.action is RetryAction.MOVE_TO_DLQ:
        await queue_repo.move_to_dlq(kind, item)
    else:
        await queue_repo.requeue(kind, item)
