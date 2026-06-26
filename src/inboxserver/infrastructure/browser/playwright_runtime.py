"""playwright 运行时：进程级单例 playwright + chromium browser（强制 headed）。

FastAPI lifespan 启动时 get_browser()，应用退出时 shutdown()。
强制 headed（headless=False 硬编码）：知乎等平台检测 headless 反爬，绝不用 headless。
容器部署需 xvfb-run 提供 X display（headed 要显示环境）。
"""

from __future__ import annotations

from playwright.async_api import Browser, Playwright, async_playwright

_pw: Playwright | None = None
_browser: Browser | None = None


async def get_browser() -> Browser:
    """单例 chromium（强制 headed）。

    headless=False 硬编码：知乎等平台检测 headless 反爬，任何场景都不用 headless。
    容器部署需 xvfb-run 提供 X display。
    --no-sandbox 适配容器权限；--disable-dev-shm-usage 防 /dev/shm 满溢。
    """
    global _pw, _browser
    if _browser is None:
        _pw = await async_playwright().start()
        _browser = await _pw.chromium.launch(
            headless=False,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
    return _browser


async def shutdown() -> None:
    """关闭 browser + playwright（应用退出 / 测试清理时调用）。"""
    global _pw, _browser
    if _browser is not None:
        await _browser.close()
        _browser = None
    if _pw is not None:
        await _pw.stop()
        _pw = None
