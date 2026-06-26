"""限速/每日限额守卫测试（fakeredis）。"""

import pytest

from inboxserver.domain.policy.daily_limit import daily_key
from inboxserver.infrastructure.queue.rate_guard import RateGuard


@pytest.fixture
def guard(fake_redis):
    return RateGuard(fake_redis)


async def test_token_acquire_within_rate(guard):
    """前 rate 次放行。"""
    for _ in range(5):
        assert await guard.token_acquire("q", rate=5, window=3600) is True


async def test_token_acquire_exceeds_rate(guard):
    """第 rate+1 次拒绝。"""
    for _ in range(3):
        await guard.token_acquire("q", rate=3, window=3600)
    assert await guard.token_acquire("q", rate=3, window=3600) is False


async def test_daily_incr_first_sets_ttl(guard, fake_redis):
    """daily_incr 首次设 25h TTL。"""
    await guard.daily_incr("q")
    ttl = await fake_redis.ttl(daily_key("q"))
    assert 80000 < ttl <= 90000


async def test_daily_count(guard):
    await guard.daily_incr("q")
    await guard.daily_incr("q")
    assert await guard.daily_count("q") == 2
