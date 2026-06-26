"""每日限额纯函数测试（daily_key/daily_ttl_seconds）。"""

from datetime import datetime, timedelta, timezone

from inboxserver.domain.policy.daily_limit import daily_key, daily_ttl_seconds

CST = timezone(timedelta(hours=8))  # UTC+8


def test_daily_key_contains_date():
    now = datetime(2026, 6, 26, 20, 0, tzinfo=CST)
    assert daily_key("queue:link", now=now) == "queue:link:daily:20260626"


def test_daily_key_cross_day():
    """跨自然日 key 变化。"""
    d1 = datetime(2026, 6, 26, 23, 59, tzinfo=CST)
    d2 = datetime(2026, 6, 27, 0, 1, tzinfo=CST)
    assert daily_key("q", now=d1) != daily_key("q", now=d2)


def test_daily_ttl_seconds_is_25h():
    """25h TTL 确保跨天后自动清零。"""
    assert daily_ttl_seconds() == 90000
