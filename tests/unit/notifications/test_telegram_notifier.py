"""TelegramNotifier 测试：sendMessage 调用 + 未配置跳过 + 失败不抛。"""

from __future__ import annotations

import json

import httpx
import respx

from inboxserver.notifications.telegram_notifier import TELEGRAM_API, TelegramNotifier


@respx.mock
async def test_notify_sends_message():
    """配置齐全 → 调用 sendMessage，body 含 chat_id 与 text"""
    route = respx.post(f"{TELEGRAM_API}/botT/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    n = TelegramNotifier("T", "123", httpx.AsyncClient())
    try:
        await n.notify("报告内容")
    finally:
        await n._http.aclose()
    assert route.called
    body = json.loads(route.calls.last.request.content)
    assert body == {"chat_id": "123", "text": "报告内容"}


async def test_notify_skip_when_unconfigured():
    """token 或 chat_id 缺失 → 跳过，不发送也不抛"""
    for token, chat in [("", "123"), ("T", "")]:
        n = TelegramNotifier(token, chat, httpx.AsyncClient())
        try:
            await n.notify("报告")  # 不抛即通过
        finally:
            await n._http.aclose()


@respx.mock
async def test_notify_non200_no_raise():
    """非 200（如 401 凭据失效）→ 不抛（附加通道，仅告警）"""
    respx.post(f"{TELEGRAM_API}/botT/sendMessage").mock(
        return_value=httpx.Response(401, text="unauthorized")
    )
    n = TelegramNotifier("T", "123", httpx.AsyncClient())
    try:
        await n.notify("报告")  # 不抛即通过
    finally:
        await n._http.aclose()
