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
from inboxserver.infrastructure.destinations.dispatcher import build_destinations
from inboxserver.infrastructure.http_client import make_http_client
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


async def run_worker() -> None:
    """启动三队列并发消费。"""
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
    tasks = [
        consume(kind, queue_repo, dedup, rate, dests[kind].dispatch, kind.value, **LIMITS[kind])
        for kind in dests
    ]
    await asyncio.gather(*tasks)


def main() -> None:
    configure_logging(settings.log_level)
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
