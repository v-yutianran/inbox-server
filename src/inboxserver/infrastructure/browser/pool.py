"""BrowserPool：按 platform 复用 BrowserContext（同 storage_state），失效可重建。

两类 context：
  context_for(platform, storage_state) —— 抓取用，缓存复用（同 storage_state 避免重复开 context）
  new_context(storage_state)           —— 登录/探测用，一次性干净 context（调用方负责 close）
"""

from __future__ import annotations

from typing import Any

from playwright.async_api import BrowserContext

from inboxserver.infrastructure.browser.playwright_runtime import get_browser


class BrowserPool:
    def __init__(self):
        self._contexts: dict[str, BrowserContext] = {}

    async def context_for(
        self, platform: str, storage_state: dict | None = None
    ) -> BrowserContext:
        """获取/缓存 platform 的 context（抓取用，复用同 storage_state）。"""
        if platform not in self._contexts:
            browser = await get_browser()
            self._contexts[platform] = await browser.new_context(**_ctx_kwargs(storage_state))
        return self._contexts[platform]

    async def new_context(self, storage_state: dict | None = None) -> BrowserContext:
        """一次性干净 context（登录/探测用），调用方负责 close。"""
        browser = await get_browser()
        return await browser.new_context(**_ctx_kwargs(storage_state))

    async def invalidate(self, platform: str) -> None:
        """丢弃 platform 的缓存 context（401 失效后，下次 context_for 重建）。"""
        ctx = self._contexts.pop(platform, None)
        if ctx is not None:
            await ctx.close()


def _ctx_kwargs(storage_state: dict | None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if storage_state:
        kwargs["storage_state"] = storage_state
    return kwargs
