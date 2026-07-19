"""worker Redis TTL 心跳公开读写边界。"""

from __future__ import annotations

from datetime import UTC, datetime

from inboxserver.infrastructure.operations.heartbeat import (
    read_worker_heartbeat,
    write_worker_heartbeat,
)


async def test_worker_heartbeat_is_online_only_while_key_exists(fake_redis):
    moment = datetime(2026, 7, 19, 6, 30, tzinfo=UTC)
    await write_worker_heartbeat(fake_redis, moment=moment)

    assert await read_worker_heartbeat(fake_redis) == "2026-07-19T06:30:00+00:00"

    await fake_redis.flushall()
    assert await read_worker_heartbeat(fake_redis) is None
