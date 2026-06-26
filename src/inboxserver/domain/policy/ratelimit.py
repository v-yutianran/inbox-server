"""固定窗口令牌桶限速（纯函数：算 Redis key + 判定；IO 在 infrastructure/queue/rate_guard）。

算法（来自 inbox_queue.token_acquire）：
  bucket key = f"{prefix}:ratelimit:{int(now // window)}"
    —— 同一窗口内 key 相同，跨窗口 key 自动切换（无需手动清零）
  首次 INCR 后 EXPIRE window+100（+100s 缓冲防窗口边界竞态）
  count <= rate 即放行
"""

from __future__ import annotations

import time


def token_bucket_key(prefix: str, now: float | None = None, window: int = 21600) -> str:
    """生成限速桶的 Redis key。同一窗口 key 相同，跨窗口 key 变化。"""
    now = time.time() if now is None else now
    return f"{prefix}:ratelimit:{int(now // window)}"


def bucket_ttl(window: int = 21600) -> int:
    """桶 TTL = window + 100s 缓冲。

    +100s 防止 key 在窗口边界提前过期导致限速短暂失效。
    """
    return window + 100


def is_within_rate(count: int, rate: int) -> bool:
    """当前窗口已用 count 是否仍 <= rate（放行）。"""
    return count <= rate
