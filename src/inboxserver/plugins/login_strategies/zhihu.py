"""知乎代登录策略：注入 z_c0 cookie → 导出 storage_state → 探测收藏 API 验证。

x-zse-93/96 签名由浏览器在页面内 fetch 时自动生成，故 storage_state 只需携带 z_c0。
（参考实现：playwright-cli default session 复用 z_c0；新方案改为显式 storage_state）
"""

from __future__ import annotations

import time

from inboxserver.infrastructure.browser.pool import BrowserPool

ZHIHU_BASE = "https://www.zhihu.com"


class ZhihuCookieLoginStrategy:
    """知乎 cookie 代登录：z_c0 注入 .zhihu.com 域。"""

    platform = "zhihu"
    requires_credentials = ["z_c0"]

    def __init__(self, pool: BrowserPool):
        self._pool = pool

    async def refresh(self, credentials: dict) -> dict:
        """凭据 z_c0 → storage_state（注入 cookie 后导出 context 状态）。"""
        z_c0 = credentials.get("z_c0")
        if not z_c0:
            raise ValueError("缺少 z_c0 凭据")
        ctx = await self._pool.new_context()
        try:
            await ctx.add_cookies(
                [
                    {
                        "name": "z_c0",
                        "value": z_c0,
                        "domain": ".zhihu.com",
                        "path": "/",
                        "httpOnly": True,
                        "secure": True,
                        "sameSite": "Lax",
                        # 持久 cookie：session cookie（无 expires）经 storage_state 导出再
                        # new_context 加载会丢失；z_c0 本就是持久 cookie，加 expires 更贴近真实
                        "expires": int(time.time()) + 30 * 86400,
                    }
                ]
            )
            return await ctx.storage_state()
        finally:
            await ctx.close()

    async def validate(self, storage_state: dict) -> bool:
        """探测 /api/v4/me：200 视为登录有效（最可靠的登录验证端点）。

        me 端点只需 cookie（不需 x-zse 签名），用 domcontentloaded 即可，
        避免 networkidle 在知乎持续请求下超时。用 me 而非 collections：
        业务端点改版不会误判登录失效。
        """
        page = None
        ctx = None
        try:
            ctx = await self._pool.new_context(storage_state)
            page = await ctx.new_page()
            await page.goto(ZHIHU_BASE, wait_until="domcontentloaded")
            result = await page.evaluate(
                """async () => {
                    const r = await fetch('/api/v4/me', {credentials: 'include'});
                    return {status: r.status};
                }"""
            )
            return result["status"] == 200
        except Exception:
            return False
        finally:
            if page is not None:
                await page.close()
            if ctx is not None:
                await ctx.close()
