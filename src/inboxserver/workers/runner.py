"""worker runner：三队列并发消费（asyncio.gather）+ graceful shutdown（SIGTERM/SIGINT）。

独立进程入口：python -m inboxserver.workers.runner
"""

from __future__ import annotations

import asyncio
import signal
from contextlib import suppress
from dataclasses import dataclass

import httpx
import redis.asyncio as aioredis
import structlog

from inboxserver.config.channels import load_channels
from inboxserver.config.logging import configure_logging
from inboxserver.config.settings import settings
from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.tags import fmt_cubox_tags, fmt_flomo_tags
from inboxserver.infrastructure.destinations.dispatcher import build_destinations
from inboxserver.infrastructure.http_client import make_http_client
from inboxserver.infrastructure.llm import generate_smart_tags
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.workers.consumer import consume

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class QueueLimits:
    """队列限速配置（来自 inbox_queue：各服务配额模型不同）。"""

    window_count: int
    window_sec: int
    daily_limit: int | None
    interval: float


# 限速常量（来自 inbox_queue：link 120/6h+480日、text 25/6h+96日、file 1400/30min）
LIMITS: dict[ItemKind, QueueLimits] = {
    ItemKind.LINK: QueueLimits(window_count=120, window_sec=21600, daily_limit=480, interval=5),
    ItemKind.TEXT: QueueLimits(window_count=25, window_sec=21600, daily_limit=96, interval=10),
    ItemKind.FILE: QueueLimits(window_count=1400, window_sec=1800, daily_limit=None, interval=1),
}


def _make_process_link(http, cubox, llm_key):
    """link 消费处理：无标签时现场调 GLM 生成智能标签 + github 来源标签，再 dispatch。

    标签在消费时（限速后）生成，避免入队洪峰瞬间打爆 GLM（对齐 inbox_dispatcher.worker）。
    """

    async def process(item):
        url = item.get("url", "")
        if not item.get("tags"):
            tags = await generate_smart_tags(http, item.get("title") or url, llm_key)
            item["tags"] = fmt_cubox_tags(tags, is_github="github.com" in url)
        return await cubox.dispatch(item)

    return process


def _make_process_text(http, flomo, llm_key):
    """text 消费处理：无标签时调 GLM 生成智能标签 + fmt_flomo_tags 拼 #前缀，再 dispatch。

    对齐老 dispatcher process_text（总是生成标签）；GLM 失败兜底为不加前缀（不阻塞）。
    标签在消费时（限速后）生成，避免入队洪峰打爆 GLM（对齐 inbox_dispatcher.worker）。
    """

    async def process(item):
        content = item.get("content", "")
        if not item.get("tags"):
            tags = await generate_smart_tags(http, content, llm_key)
            if tags:
                # flomo 标签前缀：'#标签1 #标签2 内容'
                item["content"] = f"{fmt_flomo_tags(tags)} {content}"
        return await flomo.dispatch(item)

    return process


async def _browser_collect_loop(channels, http, queue_repo, stop_event):
    """worker 定时 browser collect（每 60min），复用 worker 闲置的 chromium+Xvfb。

    browser 源 collect 必须在有 DISPLAY 的 worker 跑（server 无 DISPLAY 会崩在 chromium.launch）。
    异常隔离：collect 失败仅告警，不影响消费循环。graceful：stop_event 可立即中断等待。
    """
    from inboxserver.infrastructure.collectors.browser_collector import collect_browser_sources
    from inboxserver.infrastructure.persistence.db import async_session_factory

    while not stop_event.is_set():
        try:
            async with async_session_factory() as session:
                results = await collect_browser_sources(channels, http, queue_repo, session)
            if results:
                log.info(
                    "browser_collected",
                    enqueued={k: v.get("enqueued") for k, v in results.items()},
                )
        except Exception as e:
            # browser collect 失败不阻塞消费（附加能力，仅告警）
            log.warning("browser_collect_failed", error=repr(e))
        # 等下次（60min；stop_event 立即中断以 graceful shutdown）
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop_event.wait(), timeout=3600)


async def run_worker() -> None:
    """启动三队列并发消费。link 走智能标签增强，text/file 直接 dispatch。

    SIGTERM/SIGINT → stop_event.set() → consumer graceful shutdown（_interruptible_sleep 中断）。
    """
    channels = load_channels()
    http: httpx.AsyncClient = make_http_client()
    queue_redis = aioredis.from_url(settings.redis_url)
    queue_repo = RedisQueueRepository(queue_redis)
    dedup = DedupStore(queue_redis)
    rate = RateGuard(queue_redis)
    dests = build_destinations(channels, http)
    if not dests:
        log.warning("worker_no_destinations_exit")
        return
    log.info("worker_started", destinations=list(dests.keys()))
    llm_key = channels.llm.get("glm_api_key", "")

    # graceful shutdown 信号
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)

    tasks = []
    for kind in dests:
        lim = LIMITS[kind]
        if kind is ItemKind.LINK:
            process_fn = _make_process_link(http, dests[kind], llm_key)
        elif kind is ItemKind.TEXT:
            process_fn = _make_process_text(http, dests[kind], llm_key)
        else:
            process_fn = dests[kind].dispatch
        tasks.append(
            consume(
                kind, queue_repo, dedup, rate, process_fn, kind.value,
                window_count=lim.window_count,
                window_sec=lim.window_sec,
                daily_limit=lim.daily_limit,
                interval=lim.interval,
                stop_event=stop_event,
            )
        )
    # browser collect 定时（worker 有 Xvfb+chromium；无 browser 源时 collect_browser_sources 内部跳过）
    tasks.append(_browser_collect_loop(channels, http, queue_repo, stop_event))
    await asyncio.gather(*tasks)


def main() -> None:
    configure_logging(settings.log_level)
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
