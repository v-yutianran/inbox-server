"""成功去重存储（IO 层）。

SET done key ex=7 天；指纹算法与 key 拼接在 domain/policy/dedup。
"""

from __future__ import annotations

from redis.asyncio import Redis

from inboxserver.domain.policy.dedup import DONE_TTL, done_key


class DedupStore:
    """成功去重：mark_done 标记 / is_done 查询 / done_count 统计。"""

    def __init__(self, redis: Redis):
        self._r = redis

    async def is_done(self, queue_key: str, fingerprint: str) -> bool:
        return bool(await self._r.exists(done_key(queue_key, fingerprint)))

    async def mark_done(self, queue_key: str, fingerprint: str) -> None:
        """标记成功（7 天 TTL，防 telegram/滴答重复 + 数据监控）。"""
        await self._r.set(done_key(queue_key, fingerprint), "1", ex=DONE_TTL)

    async def done_count(self, queue_key: str) -> int:
        """统计某队列的去重条目数（scan，用于监控）。"""
        n = 0
        async for _ in self._r.scan_iter(match=f"{queue_key}:done:*"):
            n += 1
        return n
