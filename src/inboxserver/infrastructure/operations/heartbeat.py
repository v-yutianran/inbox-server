"""worker 短期 Redis 心跳。"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import redis.asyncio as aioredis

WORKER_HEARTBEAT_KEY = "operations:worker:heartbeat"
WORKER_HEARTBEAT_TTL_SECONDS = 90


async def write_worker_heartbeat(
    redis: aioredis.Redis,
    *,
    moment: datetime | None = None,
) -> None:
    current = moment or datetime.now(UTC)
    await redis.set(
        WORKER_HEARTBEAT_KEY,
        current.astimezone(UTC).isoformat(),
        ex=WORKER_HEARTBEAT_TTL_SECONDS,
    )


async def read_worker_heartbeat(redis: aioredis.Redis) -> str | None:
    value = await redis.get(WORKER_HEARTBEAT_KEY)
    if value is None:
        return None
    return value.decode() if isinstance(value, bytes) else str(value)


async def worker_heartbeat_loop(
    redis: aioredis.Redis,
    stop_event: asyncio.Event,
    *,
    interval_seconds: float = 30,
) -> None:
    while not stop_event.is_set():
        await write_worker_heartbeat(redis)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except TimeoutError:
            continue
