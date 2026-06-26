"""Scraper 测试（mock playwright page）：正常 fetch / 401→LoginExpired。"""

from unittest.mock import AsyncMock

import pytest

from inboxserver.infrastructure.browser.scraper import LoginExpired, Scraper


@pytest.fixture
def scraper():
    pool = AsyncMock()
    return Scraper(pool, "https://www.zhihu.com")


async def test_fetch_normal_returns_status_body(scraper):
    page = AsyncMock()
    page.evaluate.return_value = {"status": 200, "body": '{"data": []}'}
    ctx = AsyncMock()
    ctx.new_page.return_value = page
    scraper._pool.context_for.return_value = ctx

    result = await scraper.fetch_via_page("zhihu", {"cookies": []}, "/api/v4/collections")

    assert result == {"status": 200, "body": '{"data": []}'}
    page.goto.assert_called_once_with("https://www.zhihu.com", wait_until="domcontentloaded")
    page.close.assert_called_once()


async def test_fetch_401_raises_login_expired(scraper):
    page = AsyncMock()
    page.evaluate.return_value = {"status": 401, "body": ""}
    ctx = AsyncMock()
    ctx.new_page.return_value = page
    scraper._pool.context_for.return_value = ctx

    with pytest.raises(LoginExpired):
        await scraper.fetch_via_page("zhihu", {"cookies": []}, "/api/x")


async def test_fetch_full_url_not_prefixed(scraper):
    """完整 URL 不拼接 base_url。"""
    page = AsyncMock()
    page.evaluate.return_value = {"status": 200, "body": ""}
    ctx = AsyncMock()
    ctx.new_page.return_value = page
    scraper._pool.context_for.return_value = ctx

    await scraper.fetch_via_page("zhihu", {}, "https://other.com/api")
    # evaluate 收到的 url 应为完整 URL
    passed_url = page.evaluate.call_args[0][1]
    assert passed_url == "https://other.com/api"
