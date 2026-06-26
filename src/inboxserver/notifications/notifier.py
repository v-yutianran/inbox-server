"""通知契约（Protocol）。

通知是附加通道（汇总/失败告警），失败不应阻塞主流程。
MVP 默认 LogNotifier；后续可加 Telegram/Email notifier（实现此接口即可）。
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Notifier(Protocol):
    async def notify(self, message: str) -> None:
        """发送一条通知消息。"""
        ...
