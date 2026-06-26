"""限速纯函数测试（token_bucket_key/bucket_ttl/is_within_rate）。"""

from inboxserver.domain.policy.ratelimit import (
    bucket_ttl,
    is_within_rate,
    token_bucket_key,
)


def test_token_bucket_key_same_window():
    """同一窗口内（now//window 相同）key 相同。"""
    k1 = token_bucket_key("q", now=1000.0, window=100)
    k2 = token_bucket_key("q", now=1050.0, window=100)
    assert k1 == k2 == "q:ratelimit:10"


def test_token_bucket_key_cross_window():
    """跨窗口 key 变化。"""
    assert token_bucket_key("q", now=100.0, window=100) == "q:ratelimit:1"
    assert token_bucket_key("q", now=200.0, window=100) == "q:ratelimit:2"


def test_bucket_ttl_is_window_plus_100():
    """桶 TTL = window + 100s 缓冲。"""
    assert bucket_ttl(21600) == 21700
    assert bucket_ttl(1800) == 1900


def test_is_within_rate_boundary():
    """count <= rate 放行，rate+1 拒绝。"""
    assert is_within_rate(0, 5) is True
    assert is_within_rate(5, 5) is True  # 等于 rate 仍放行
    assert is_within_rate(6, 5) is False
