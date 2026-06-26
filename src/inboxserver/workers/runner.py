"""worker runner：三队列并发消费（asyncio.gather）。

独立进程入口：python -m inboxserver.workers.runner
"""

from __future__ import annotations

import asyncio

import httpx
import redis.asyncio as aioredis

from inboxserver.config.channels import load_channels
from inboxserver.config.logging import configure_logging
from inboxserver.config.settings import settings
from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.tags import fmt_cubox_tags
from inboxserver.infrastructure.destinations.dispatcher import build_destinations
from inboxserver.infrastructure.http_client import make_http_client
from inboxserver.infrastructure.llm import generate_smart_tags
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.workers.consumer import consume

# 限速常量（来自 inbox_queue：link 120/6h+480日、text 25/6h+96日、file 1400/30min）
LIMITS = {
    ItemKind.LINK: dict(window_count=120, window_sec=21600, daily_limit=480, interval=5),
    ItemKind.TEXT: dict(window_count=25, window_sec=21600, daily_limit=96, interval=10),
    ItemKind.FILE: dict(window_count=1400, window_sec=1800, daily_limit=None, interval=1),
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


async def run_worker() -> None:
    """启动三队列并发消费。link 走智能标签增强，text/file 直接 dispatch。"""
    channels = load_channels()
    http: httpx.AsyncClient = make_http_client()
    queue_redis = aioredis.from_url(settings.redis_url)
    queue_repo = RedisQueueRepository(queue_redis)
    dedup = DedupStore(queue_redis)
    rate = RateGuard(queue_redis)
    dests = build_destinations(channels, http)
    if not dests:
        print("[worker] 无启用的 destination，退出")
        return
    llm_key = channels.llm.get("glm_api_key", "")
    tasks = []
    for kind in dests:
        if kind is ItemKind.LINK:
            process_fn = _make_process_link(http, dests[kind], llm_key)
        else:
            process_fn = dests[kind].dispatch
        tasks.append(
            consume(kind, queue_repo, dedup, rate, process_fn, kind.value, **LIMITS[kind])
        )
    await asyncio.gather(*tasks)


def main() -> None:
    configure_logging(settings.log_level)
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
