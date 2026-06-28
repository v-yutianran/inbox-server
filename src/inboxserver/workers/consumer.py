"""通用消费循环：限速 / 去重 / 重试 / DLQ + graceful shutdown（async）。

process_fn(item) -> (ok, DispatchOutcome)。stop_event.set() 触发 graceful shutdown
（_interruptible_sleep 立即中断，处理完当前 item 后退出）。
"""

from __future__ import annotations

import asyncio

import structlog

from inboxserver.domain.models import ItemKind, QueueLimits
from inboxserver.domain.policy.dedup import fingerprint
from inboxserver.domain.policy.retry import RetryAction, decide_on_failure
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository, queue_key
from inboxserver.plugins.contracts import DispatchOutcome

log = structlog.get_logger()


async def consume(
    kind: ItemKind,
    queue_repo: RedisQueueRepository,
    dedup_store: DedupStore,
    rate_guard: RateGuard,
    process_fn,
    name: str,
    *,
    limits: QueueLimits,
    stop_event: asyncio.Event | None = None,
) -> None:
    """通用消费循环。

    流程：每日限额→dequeue→去重→窗口限速→process→OK(mark_done+daily_incr)/QUOTA(requeue停)/FAIL(retry/DLQ)。
    stop_event.set() 触发 graceful shutdown（_interruptible_sleep 立即中断）。
    """
    qkey = queue_key(kind)
    structlog.contextvars.bind_contextvars(kind=kind.value)
    while stop_event is None or not stop_event.is_set():
        # 每日限额：满则停等明天（不消费、不 DLQ）
        if (
            limits.daily_limit is not None
            and await rate_guard.daily_count(qkey) >= limits.daily_limit
        ):
            await _interruptible_sleep(1800, stop_event)
            continue
        item = await queue_repo.dequeue(kind)
        if not item:
            await _interruptible_sleep(60, stop_event)  # 队列空，1 分钟后再查
            continue
        # 成功去重：已处理跳过
        fp = fingerprint(item, kind)
        if await dedup_store.is_done(qkey, fp):
            continue
        # 窗口限速：满则回队尾等下个窗口
        if not await rate_guard.token_acquire(qkey, limits.window_count, limits.window_sec):
            await queue_repo.requeue(kind, item)
            await _interruptible_sleep(300, stop_event)
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
                await _interruptible_sleep(1800, stop_event)
                continue
            else:  # FAIL
                await _handle_fail(kind, queue_repo, item)
        except Exception as e:
            log.warning("consume_exception", name=name, error=repr(e))
            await _handle_fail(kind, queue_repo, item)
        await _interruptible_sleep(limits.interval, stop_event)
    log.info("consumer_shutdown", name=name)


async def _interruptible_sleep(seconds: float, stop_event: asyncio.Event | None) -> None:
    """可被 stop_event 中断的 sleep（graceful shutdown 快速响应）。

    stop_event.wait() 被 set 时立即返回（中断 sleep），否则等 timeout 秒。
    """
    if stop_event is None:
        await asyncio.sleep(seconds)
    else:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=seconds)
        except TimeoutError:
            pass  # 超时正常继续


async def _handle_fail(kind: ItemKind, queue_repo: RedisQueueRepository, item: dict) -> None:
    """失败/异常：retry+1，满 MAX_RETRY 进 DLQ，否则回队尾重试。"""
    d = decide_on_failure(item.get("retry", 0))
    item["retry"] = d.retry
    if d.action is RetryAction.MOVE_TO_DLQ:
        await queue_repo.move_to_dlq(kind, item)
    else:
        await queue_repo.requeue(kind, item)
