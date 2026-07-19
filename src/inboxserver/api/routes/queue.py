"""队列状态端点：GET /queue（各内容类型计数）/queue/dlq（死信内容）。

遍历 ItemKind（link/text/file/article）四类队列，复用 RedisQueueRepository +
DedupStore，是 IO 层的只读包装（无业务逻辑）。挂 require_api_key（队列属运维敏感）。
"""

from __future__ import annotations

from typing import Annotated

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends

from inboxserver.api.auth import require_api_key
from inboxserver.api.deps import get_redis
from inboxserver.domain.models import ItemKind
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.repository import RedisQueueRepository, queue_key

router = APIRouter(prefix="/queue", tags=["queue"])


async def queue_summary(queue_redis: aioredis.Redis) -> dict[str, dict[str, int]]:
    """读取四类队列的 pending、dlq 与 done 计数。"""
    repo = RedisQueueRepository(queue_redis)
    dedup = DedupStore(queue_redis)
    queues: dict[str, dict[str, int]] = {}
    for kind in ItemKind:
        queues[kind.value] = {
            "pending": await repo.len(kind),
            "dlq": await repo.dlq_len(kind),
            "done": await dedup.done_count(queue_key(kind)),
        }
    return queues


@router.get("")
async def list_queue(
    queue_redis: Annotated[aioredis.Redis, Depends(get_redis)],
    _: Annotated[None, Depends(require_api_key)],
) -> dict:
    """各内容类型队列状态：pending（待消费）/ dlq（死信）/ done（去重已处理）。"""
    return {"status": "ok", "queues": await queue_summary(queue_redis)}


@router.get("/dlq")
async def list_dlq(
    queue_redis: Annotated[aioredis.Redis, Depends(get_redis)],
    _: Annotated[None, Depends(require_api_key)],
) -> dict:
    """死信队列内容（失败满 3 次的项）。payload 仅含 url/title，运维信息，已鉴权可返。"""
    repo = RedisQueueRepository(queue_redis)
    dlq: dict[str, list[dict]] = {}
    counts: dict[str, int] = {}
    for kind in ItemKind:
        items = await repo.peek_dlq(kind)
        dlq[kind.value] = items
        counts[kind.value] = len(items)
    return {"status": "ok", "counts": counts, "dlq": dlq}
