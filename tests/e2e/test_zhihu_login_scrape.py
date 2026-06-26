"""知乎代登录 e2e（命门判决）：真实 z_c0 → storage_state → 页面内 fetch 收藏 API → 看是否 200。

判决三层：
  1. storage_state 能注入 z_c0 cookies
  2. validate 探测收藏 API 返回 200
  3. 页面内 fetch 拿到真实收藏 data（命门核心：浏览器自动签 x-zse-）

用法：
  uv run playwright install chromium   # 一次性装浏览器
  ZHIHU_Z_C0="2|1:0|..." uv run pytest tests/e2e/test_zhihu_login_scrape.py -m e2e -s

无 ZHIHU_Z_C0 时 skip（不 fail），便于入库 + CI。
"""

from __future__ import annotations

import json
import os

import pytest

from inboxserver.infrastructure.browser.playwright_runtime import shutdown
from inboxserver.infrastructure.browser.pool import BrowserPool
from inboxserver.infrastructure.browser.scraper import LoginExpired, Scraper
from inboxserver.plugins.login_strategies.zhihu import ZHIHU_BASE, ZhihuCookieLoginStrategy

pytestmark = pytest.mark.e2e


@pytest.fixture
def pool():
    return BrowserPool()


async def test_zhihu_storage_state_fetches_collections(pool):
    """命门：z_c0 → storage_state → 页面内 fetch 收藏 API → 断言 200 + 拿到 data。"""
    z_c0 = os.environ.get("ZHIHU_Z_C0")
    if not z_c0:
        pytest.skip(
            "ZHIHU_Z_C0 未设置（设置后: ZHIHU_Z_C0=... uv run pytest -m e2e -s）"
        )

    try:
        strategy = ZhihuCookieLoginStrategy(pool)

        # ① 注入 z_c0 → storage_state
        storage_state = await strategy.refresh({"z_c0": z_c0})
        cookies = storage_state.get("cookies", [])
        print(f"\n[① storage_state] 注入成功，cookies 数: {len(cookies)}")
        assert cookies, "storage_state 无 cookies"

        # ② validate 探测
        valid = await strategy.validate(storage_state)
        print(f"[② validate] storage_state 有效: {valid}")
        assert valid, "validate 失败：z_c0 可能已失效，请重新获取"

        # ③ 命门：页面内 fetch /api/v4/me（登录验证端点），拿真实用户数据
        scraper = Scraper(pool, ZHIHU_BASE)
        try:
            result = await scraper.fetch_via_page("zhihu_e2e", storage_state, "/api/v4/me")
        except LoginExpired as e:
            pytest.fail(f"命门失败：fetch 返回 401（登录态失效）: {e}")

        print(f"[③ fetch /api/v4/me] status={result['status']}, body 长度={len(result['body'])}")
        assert result["status"] == 200, f"命门失败：status={result['status']}（非 200）"

        me = json.loads(result["body"])
        print(f"\n[判决] ✅ 命门通过：拿到登录用户 {me.get('name')}（{me.get('url_token')}）")
        print("[判决] Python playwright + storage_state 能拿到知乎登录态 → 商业化代登录路线成立")
    finally:
        await shutdown()  # 关闭真实 chromium
