"""领域值对象：内容类型、书签、队列项。纯数据，无 IO。"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class ItemKind(StrEnum):
    """队列内容类型（队列键按此命名，不绑具体服务，换服务零改动）。"""

    LINK = "link"  # 链接 → Cubox
    TEXT = "text"  # 纯文本 → flomo
    FILE = "file"  # 文件 → 坚果云


@dataclass(frozen=True)
class Bookmark:
    """从书签源解析出的单条书签。

    知乎/inoreader/YouTube/B站统一导出 Netscape HTML 后解析为此结构。
    """

    url: str
    title: str = ""


@dataclass
class QueueItem:
    """队列项：内容类型 + 载荷。

    载荷结构随 kind 而异：
      link={url,title,tags} / text={content} / file={local_path,remote_name}
    """

    kind: ItemKind
    payload: dict
    retry: int = 0
    # 允许 extra 字段透传（如 worker 回写 retry），保持与现有 payload JSON 兼容
    extra: dict = field(default_factory=dict)


@dataclass(frozen=True)
class QueueLimits:
    """队列限速配置：窗口令牌 + 日限额 + 消费间隔（来自 inbox_queue 各服务配额模型）。

    consume 按此限速消费，避免打爆下游（Cubox/flomo/坚果云）。frozen=True：配置不可变，
    避免运行中被误改导致限速失真。
    """

    window_count: int
    window_sec: int
    daily_limit: int | None
    interval: float
