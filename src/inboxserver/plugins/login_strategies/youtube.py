"""YouTube 代登录：Google 账号 storage_state（全 session），validate 检查不重定向 accounts.google.com。

YouTube 用 Google 全 session（无单 cookie）。客户提供 storage_state。
"""

from __future__ import annotations

from inboxserver.infrastructure.browser.pool import BrowserPool

YT_BASE = "https://www.youtube.com"


class YouTubeSessionLoginStrategy:
    platform = "youtube"
    requires_credentials = ["storage_state"]

    def __init__(self, pool: BrowserPool):
        self._pool = pool

    async def refresh(self, credentials: dict) -> dict:
        state = credentials.get("storage_state")
        if not state:
            raise ValueError("缺少 storage_state")
        return state

    async def validate(self, storage_state: dict) -> bool:
        """goto WL playlist 不重定向 accounts.google.com 视为有效。"""
        page = None
        ctx = None
        try:
            ctx = await self._pool.new_context(storage_state)
            page = await ctx.new_page()
            await page.goto(f"{YT_BASE}/playlist?list=WL", wait_until="domcontentloaded")
            return "accounts.google.com" not in page.url
        except Exception:
            return False
        finally:
            if page is not None:
                await page.close()
            if ctx is not None:
                await ctx.close()
