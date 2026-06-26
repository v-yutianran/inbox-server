"""inoreader 代登录：客户提供完整 storage_state，validate 检查不重定向 /login。

全 session（多 cookie），不像知乎单 z_c0；客户从浏览器导出 storage_state。
"""

from __future__ import annotations

from inboxserver.infrastructure.browser.pool import BrowserPool

INOREADER_BASE = "https://www.inoreader.com"


class InoreaderSessionLoginStrategy:
    platform = "inoreader"
    requires_credentials = ["storage_state"]

    def __init__(self, pool: BrowserPool):
        self._pool = pool

    async def refresh(self, credentials: dict) -> dict:
        """客户提供的 storage_state 直接用（inoreader 全 session，无单点注入）。"""
        state = credentials.get("storage_state")
        if not state:
            raise ValueError("缺少 storage_state")
        return state

    async def validate(self, storage_state: dict) -> bool:
        """goto /starred 不重定向到 /login 或 /signin 视为有效。"""
        page = None
        ctx = None
        try:
            ctx = await self._pool.new_context(storage_state)
            page = await ctx.new_page()
            await page.goto(f"{INOREADER_BASE}/starred", wait_until="domcontentloaded")
            return "/login" not in page.url and "/signin" not in page.url
        except Exception:
            return False
        finally:
            if page is not None:
                await page.close()
            if ctx is not None:
                await ctx.close()
