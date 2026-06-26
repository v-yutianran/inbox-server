"""每日限额（纯函数：算 key + TTL；IO 在 rate_guard）。

算法（来自 inbox_queue.daily_incr）：
  key = f"{prefix}:daily:{strftime('%Y%m%d')}"  —— 按本地日期分桶
  首次 INCR 后 EXPIRE 90000（25h，确保跨天后自动清零）
"""

from __future__ import annotations

from datetime import datetime


def daily_key(prefix: str, now: datetime | None = None) -> str:
    """生成每日限额桶的 Redis key（含当日 %Y%m%d）。

    now 需带时区；默认用本地时间（每日限额按用户本地日历日结算）。
    """
    now = (now or datetime.now().astimezone())
    return f"{prefix}:daily:{now.strftime('%Y%m%d')}"


def daily_ttl_seconds() -> int:
    """每日桶 TTL = 90000s（25h），跨天后自动清零。"""
    return 90000
