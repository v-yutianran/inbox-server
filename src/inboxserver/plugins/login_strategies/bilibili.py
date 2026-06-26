"""bilibili 代登录：注入 SESSDATA cookie（.bilibili.com），validate 检查不重定向登录。

B站用官方 API（api.bilibili.com），SESSDATA 跨子域（www→api）自动带（credentials:include）。
类似知乎 z_c0 单 cookie 模式。
"""

from __future__ import annotations

import time

from inboxserver.infrastructure.browser.pool import BrowserPool

BILI_BASE = "https://www.bilibili.com"


class BilibiliCookieLoginStrategy:
    platform = "bilibili"
    requires_credentials = ["sessdata"]

    def __init__(self, pool: BrowserPool):
        self._pool = pool

    async def refresh(self, credentials: dict) -> dict:
        """注入 SESSDATA → storage_state。"""
        sessdata = credentials.get("sessdata")
        if not sessdata:
            raise ValueError("缺少 sessdata")
        ctx = await self._pool.new_context()
        try:
            await ctx.add_cookies(
                [
                    {
                        "name": "SESSDATA",
                        "value": sessdata,
                        "domain": ".bilibili.com",
                        "path": "/",
                        "httpOnly": True,
                        "secure": True,
                        "sameSite": "Lax",
                        "expires": int(time.time()) + 30 * 86400,
                    }
                ]
            )
            return await ctx.storage_state()
        finally:
            await ctx.close()

    async def validate(self, storage_state: dict) -> bool:
        """goto bilibili 首页不重定向 passport.bilibili.com/login 视为有效。"""
        page = None
        ctx = None
        try:
            ctx = await self._pool.new_context(storage_state)
            page = await ctx.new_page()
            await page.goto(f"{BILI_BASE}/", wait_until="domcontentloaded")
            return "passport.bilibili.com/login" not in page.url
        except Exception:
            return False
        finally:
            if page is not None:
                await page.close()
            if ctx is not None:
                await ctx.close()
