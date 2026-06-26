"""Scraper：用 storage_state 开 context，在平台页面内 evaluate fetch。

绝不退回裸 httpx——知乎 x-zse-93/96 等抗反爬签名只有页面内 fetch 才能正确生成，
storage_state 仅提供 z_c0 等 cookie，二者结合才能拿到 200。
401 → 抛 LoginExpired 让上层重登（最多重试 1 次）。
"""

from __future__ import annotations

from inboxserver.infrastructure.browser.pool import BrowserPool


class LoginExpired(Exception):
    """storage_state 失效（401），需上层重登。"""


class Scraper:
    def __init__(self, pool: BrowserPool, base_url: str):
        self._pool = pool
        self._base_url = base_url

    async def fetch_via_page(
        self, platform: str, storage_state: dict, path_or_url: str
    ) -> dict:
        """在 platform 页面内 fetch（带 storage_state cookie + 浏览器签名）。

        path_or_url：相对路径（拼 base_url）或完整 URL。
        返回 {status, body}。401 抛 LoginExpired。
        """
        ctx = await self._pool.context_for(platform, storage_state)
        page = await ctx.new_page()
        try:
            await page.goto(self._base_url, wait_until="domcontentloaded")
            url = (
                path_or_url
                if path_or_url.startswith("http")
                else f"{self._base_url}{path_or_url}"
            )
            result = await page.evaluate(
                """async (url) => {
                    const r = await fetch(url, {credentials: 'include'});
                    return {status: r.status, body: await r.text()};
                }""",
                url,
            )
            if result["status"] == 401:
                raise LoginExpired(f"{platform} 返回 401，storage_state 失效")
            return result
        finally:
            await page.close()
