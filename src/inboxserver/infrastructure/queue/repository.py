"""Redis 队列 Repository（IO 层，包 LPUSH/RPOP 语义）。

算法（FIFO，来自 inbox_queue）：
  LPUSH 入队（头部）+ RPOP 出队（尾部）；失败/配额 LPUSH 回队。
键按内容类型 queue:link|text|file，不绑具体服务（换服务零改动）。
"""

from __future__ import annotations

import json

from redis.asyncio import Redis

from inboxserver.domain.models import ItemKind


def queue_key(kind: ItemKind) -> str:
    """主队列 key（按内容类型命名）。"""
    return f"queue:{kind.value}"


def dlq_key(kind: ItemKind) -> str:
    """死信队列 key。"""
    return f"queue:{kind.value}:failed"


class RedisQueueRepository:
    """队列操作：enqueue/dequeue/requeue/move_to_dlq/len/peek/clear。"""

    def __init__(self, redis: Redis):
        self._r = redis

    async def enqueue(self, kind: ItemKind, payload: dict) -> None:
        """入队（LPUSH 头部）。"""
        await self._r.lpush(queue_key(kind), _dumps(payload))

    async def dequeue(self, kind: ItemKind) -> dict | None:
        """出队（RPOP 尾部，FIFO）。空队列返回 None。"""
        return _loads(await self._r.rpop(queue_key(kind)))

    async def requeue(self, kind: ItemKind, payload: dict) -> None:
        """回队（LPUSH 头部，重新参与消费）。"""
        await self._r.lpush(queue_key(kind), _dumps(payload))

    async def move_to_dlq(self, kind: ItemKind, payload: dict) -> None:
        """移入死信队列（失败满 3 次）。"""
        await self._r.lpush(dlq_key(kind), _dumps(payload))

    async def len(self, kind: ItemKind) -> int:
        return await self._r.llen(queue_key(kind))

    async def peek_all(self, kind: ItemKind) -> list[dict]:
        """查看全部（不消费），用于监控/DLQ 检查。"""
        raws = await self._r.lrange(queue_key(kind), 0, -1)
        return [item for item in (_loads(r) for r in raws) if item is not None]

    async def dlq_len(self, kind: ItemKind) -> int:
        return await self._r.llen(dlq_key(kind))

    async def clear(self, kind: ItemKind) -> None:
        await self._r.delete(queue_key(kind))


def _dumps(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _loads(raw) -> dict | None:
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode()
    return json.loads(raw)
