"""限速 / 每日限额守卫（IO 层，执行 Redis INCR/EXPIRE）。

key 与 TTL 的计算在 domain/policy（ratelimit/daily_limit）——本层只负责 IO。
"""

from __future__ import annotations

from redis.asyncio import Redis

from inboxserver.domain.policy.daily_limit import daily_key, daily_ttl_seconds
from inboxserver.domain.policy.ratelimit import bucket_ttl, is_within_rate, token_bucket_key


class RateGuard:
    """固定窗口令牌桶 + 每日限额。"""

    def __init__(self, redis: Redis):
        self._r = redis

    async def token_acquire(self, prefix: str, rate: int, window: int = 21600) -> bool:
        """窗口令牌桶：放行返回 True，窗口满返回 False。

        INCR 桶 key（同窗口 key 相同），首次设 TTL=window+100。
        """
        key = token_bucket_key(prefix, window=window)
        count = await self._r.incr(key)
        if count == 1:
            await self._r.expire(key, bucket_ttl(window))
        return is_within_rate(count, rate)

    async def daily_count(self, prefix: str) -> int:
        return int(await self._r.get(daily_key(prefix)) or 0)

    async def daily_incr(self, prefix: str) -> int:
        """成功消费后递增当日计数；首次设 25h TTL（跨天自动清零）。"""
        key = daily_key(prefix)
        c = await self._r.incr(key)
        if c == 1:
            await self._r.expire(key, daily_ttl_seconds())
        return c
