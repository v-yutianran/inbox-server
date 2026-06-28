"""一次性 baseline 初始化：B站全量（fav 翻页 + 稍后再看）→ 填 incremental_baselines（不 cubox）。

用途：从老 dispatcher（或首次启用）切换到 inbox-server 时，预填 baseline，
让 inbox-server 后续 collect 只推**增量**（新增才 cubox），不重复导入老 dispatcher 已导入的。

跑法（避免与 worker collect 并发竞态，致首次全量重复）：
    docker compose stop worker    # 1. 停 worker（collect 停，不与脚本并发）
    # 2. 新容器跑脚本（Xvfb+chromium；--rm 跑完即删）：
    docker compose run --rm worker sh -c \
      "Xvfb :99 & export DISPLAY=:99 && uv run python scripts/init_bilibili_baseline.py"
    docker compose start worker   # 3. 启 worker（collect 增量，baseline 已填不重复）

前置：channels.yaml 已启用 bilibili（media_id + credential_name=bilibili_creds）+
      bilibili_toview（credential_name=bilibili_creds），且已 POST /login/bilibili/cookie。
"""

from __future__ import annotations

import asyncio

from inboxserver.config.channels import load_channels
from inboxserver.config.logging import configure_logging
from inboxserver.config.settings import settings
from inboxserver.infrastructure.browser.pool import BrowserPool
from inboxserver.infrastructure.browser.scraper import Scraper
from inboxserver.infrastructure.browser.session_manager import LoginSessionManager
from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
from inboxserver.infrastructure.persistence.db import async_session_factory
from inboxserver.infrastructure.persistence.repositories.baseline import IncrementalBaselineRepo
from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo
from inboxserver.infrastructure.persistence.repositories.login_session import LoginSessionRepo
from inboxserver.plugins.login_strategies.bilibili import BILI_BASE, BilibiliCookieLoginStrategy
from inboxserver.plugins.sources.bilibili import MAX_PAGES, parse_bilibili_favorites
from inboxserver.plugins.sources.bilibili_toview import TOVIEW_API, parse_bilibili_toview

BILI_FAV_API = "https://api.bilibili.com/x/v3/fav/resource/list"


async def init_baseline() -> None:
    """B站全量 fav 翻页 + 稍后再看 → 填 baseline（bilibili + bilibili_toview）。不 cubox。"""
    configure_logging(settings.log_level)
    async with async_session_factory() as session:
        pool = BrowserPool()
        sm = LoginSessionManager(
            pool, CredentialVault(), CredentialRepo(session), LoginSessionRepo(session),
            {"bilibili": BilibiliCookieLoginStrategy(pool)},
        )
        scraper = Scraper(pool, BILI_BASE)
        baseline = IncrementalBaselineRepo(session)

        # channels.yaml 取 bilibili media_id + credential（用户已配）
        enabled = load_channels().enabled_sources()
        bili = enabled.get("bilibili")
        if not bili:
            print("⚠️ channels.yaml 未启用 bilibili（需 media_id + credential_name），终止")
            return
        media_id = bili.config["media_id"]
        cred = bili.config["credential_name"]
        print(f"启用 bilibili：media_id={media_id}, credential={cred}")

        storage_state = await sm.acquire("bilibili", cred)

        # 1. 「我的收藏」全量翻页 → baseline
        fav_urls: set[str] = set()
        for pn in range(1, MAX_PAGES + 1):
            url = f"{BILI_FAV_API}?media_id={media_id}&pn={pn}&ps=20"
            r = await scraper.fetch_via_page("bilibili", storage_state, url)
            bms = parse_bilibili_favorites(r.get("body", ""))
            if not bms:
                break  # 空页（抓完）
            fav_urls.update(b.url for b in bms)
            print(f"  fav pn={pn}: +{len(bms)}（累计 {len(fav_urls)}）")
        await baseline.save_known("bilibili", fav_urls)
        print(f"✓ bilibili baseline：{len(fav_urls)} 条")

        # 2. 「稍后再看」全量 → baseline（仅当 channels.yaml 启用 bilibili_toview）
        if "bilibili_toview" in enabled:
            r = await scraper.fetch_via_page("bilibili", storage_state, TOVIEW_API)
            toview_urls = {b.url for b in parse_bilibili_toview(r.get("body", ""))}
            await baseline.save_known("bilibili_toview", toview_urls)
            print(f"✓ bilibili_toview baseline：{len(toview_urls)} 条")
        else:
            print("（channels.yaml 未启用 bilibili_toview，跳过）")

        print(
            "\n完成：baseline 已填（不 cubox）。后续 worker collect 只推增量（新增才 cubox），"
            "不重复老 dispatcher 已导入的。"
        )


if __name__ == "__main__":
    asyncio.run(init_baseline())
