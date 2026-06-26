"""成功去重指纹（纯函数；IO 在 infrastructure/queue/dedup_store）。

算法（来自 worker._dedup_key + inbox_queue.is_done/mark_done）：
  指纹：link=url 原值 / text=md5(content) / file=remote_name
  done key = f"{queue_key}:done:{指纹}"，SET ex=604800(7天)
"""

from __future__ import annotations

import hashlib

from inboxserver.domain.models import ItemKind

# 成功去重窗口：7 天内相同内容不再重复分发
DONE_TTL = 604800


def fingerprint(item: dict, kind: ItemKind) -> str:
    """计算去重指纹：link=url / text=md5(content) / file=remote_name。"""
    if kind == ItemKind.LINK:
        return item.get("url", "")
    if kind == ItemKind.TEXT:
        return hashlib.md5(item.get("content", "").encode()).hexdigest()
    if kind == ItemKind.FILE:
        return item.get("remote_name", "")
    return ""


def done_key(queue_key: str, fp: str) -> str:
    """拼接去重 SET 的 Redis key（queue:link:done:{指纹}）。"""
    return f"{queue_key}:done:{fp}"
