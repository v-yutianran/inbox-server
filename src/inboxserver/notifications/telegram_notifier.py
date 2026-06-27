"""Telegram 通知器：用 bot sendMessage 发同步报告（复刻老 dispatcher.send_telegram）。

复用 telegram source 的 bot_token；chat_id 来自 channels.yaml notification 段。
失败不抛（通知是附加通道，不阻塞主同步流程）。
"""

from __future__ import annotations

import httpx
import structlog

TELEGRAM_API = "https://api.telegram.org"

_log = structlog.get_logger(__name__)


class TelegramNotifier:
    """Telegram bot sendMessage 发同步报告。"""

    def __init__(self, bot_token: str, chat_id: str, http: httpx.AsyncClient):
        self._token = bot_token
        self._chat_id = chat_id
        self._http = http

    async def notify(self, message: str) -> None:
        """sendMessage 发送。未配置/失败均不抛（附加通道）。"""
        # 未配置 bot_token 或 chat_id：跳过（不报错，由调用方决定是否配）
        if not self._token or not self._chat_id:
            return
        try:
            resp = await self._http.post(
                f"{TELEGRAM_API}/bot{self._token}/sendMessage",
                json={"chat_id": self._chat_id, "text": message},
            )
            if resp.status_code != 200:
                # 非 200 记日志（凭据失效/chat_id 错等），便于排查"为什么没收到报告"
                _log.warning(
                    "telegram_notify_failed",
                    status=resp.status_code,
                    body=resp.text[:200],
                )
        except Exception as e:
            # 网络等异常：不阻塞主流程，仅告警
            _log.warning("telegram_notify_error", error=repr(e))
