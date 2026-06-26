"""知乎代登录策略测试（mock playwright context/page）。"""

from unittest.mock import AsyncMock

import pytest

from inboxserver.plugins.login_strategies.zhihu import ZhihuCookieLoginStrategy


@pytest.fixture
def strategy():
    return ZhihuCookieLoginStrategy(AsyncMock())


async def test_refresh_injects_zc0_cookie(strategy):
    ctx = AsyncMock()
    ctx.storage_state.return_value = {"cookies": [{"name": "z_c0"}]}
    strategy._pool.new_context.return_value = ctx

    state = await strategy.refresh({"z_c0": "abc"})

    ctx.add_cookies.assert_called_once()
    cookie = ctx.add_cookies.call_args[0][0][0]
    assert cookie["name"] == "z_c0"
    assert cookie["value"] == "abc"
    assert cookie["domain"] == ".zhihu.com"
    assert state == {"cookies": [{"name": "z_c0"}]}
    ctx.close.assert_called_once()  # 一次性 context 用完即关


async def test_refresh_missing_zc0_raises(strategy):
    with pytest.raises(ValueError, match="z_c0"):
        await strategy.refresh({})


async def test_validate_200_is_true(strategy):
    page = AsyncMock()
    page.evaluate.return_value = {"status": 200}
    ctx = AsyncMock()
    ctx.new_page.return_value = page
    strategy._pool.new_context.return_value = ctx

    assert await strategy.validate({"cookies": []}) is True


async def test_validate_401_is_false(strategy):
    page = AsyncMock()
    page.evaluate.return_value = {"status": 401}
    ctx = AsyncMock()
    ctx.new_page.return_value = page
    strategy._pool.new_context.return_value = ctx

    assert await strategy.validate({"cookies": []}) is False


async def test_validate_exception_is_false(strategy):
    """playwright 异常 → 视为失效（不抛出，降级 False）。"""
    ctx = AsyncMock()
    ctx.new_page.side_effect = RuntimeError("browser crashed")
    strategy._pool.new_context.return_value = ctx

    assert await strategy.validate({"cookies": []}) is False
