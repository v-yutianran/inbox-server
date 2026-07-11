"""X 代登录：客户提供完整 storage_state，validate 检查不重定向登录流。"""

from __future__ import annotations

from inboxserver.infrastructure.browser.pool import BrowserPool

X_BASE = "https://x.com"


class XSessionLoginStrategy:
    platform = "x"
    requires_credentials = ["storage_state"]

    def __init__(self, pool: BrowserPool):
        self._pool = pool

    async def refresh(self, credentials: dict) -> dict:
        """客户提供的 storage_state 直接用（X 全 session，无账号密码登录）。"""
        state = credentials.get("storage_state")
        if not state:
            raise ValueError("缺少 storage_state")
        return state

    async def validate(self, storage_state: dict) -> bool:
        """goto Bookmarks 不进入登录流视为有效。"""
        page = None
        ctx = None
        try:
            ctx = await self._pool.new_context(storage_state)
            page = await ctx.new_page()
            await page.goto(f"{X_BASE}/i/bookmarks", wait_until="domcontentloaded")
            return not is_x_login_url(page.url)
        except Exception:
            return False
        finally:
            if page is not None:
                await page.close()
            if ctx is not None:
                await ctx.close()


def is_x_login_url(url: str) -> bool:
    """识别 X 登录/风控流 URL。"""
    return "/login" in url or "/i/flow/login" in url or "/account/access" in url
