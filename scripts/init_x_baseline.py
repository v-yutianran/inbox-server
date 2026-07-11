"""一次性 baseline 初始化：X Bookmarks/Likes 可见 tweet id → 填 incremental_baselines（不 cubox）。

用途：首次启用 X source 前预填 baseline，让 worker 后续 collect 只推增量。

跑法（避免与 worker collect 并发竞态，致首次全量重复）：
    docker compose stop worker
    docker compose run --rm worker sh -c \
      "Xvfb :99 & export DISPLAY=:99 && uv run python scripts/init_x_baseline.py"
    docker compose start worker

前置：channels.yaml 已启用 x_bookmarks 和/或 x_likes（credential_name=x_creds），
      且已通过 scripts/import_credentials.py 写入 x_creds。
"""

from __future__ import annotations

import asyncio

from inboxserver.config.channels import load_channels
from inboxserver.config.logging import configure_logging
from inboxserver.config.settings import settings
from inboxserver.infrastructure.browser.pool import BrowserPool
from inboxserver.infrastructure.browser.session_manager import LoginSessionManager
from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
from inboxserver.infrastructure.persistence.db import async_session_factory
from inboxserver.infrastructure.persistence.repositories.baseline import IncrementalBaselineRepo
from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo
from inboxserver.infrastructure.persistence.repositories.login_session import LoginSessionRepo
from inboxserver.plugins.login_strategies.x import XSessionLoginStrategy
from inboxserver.plugins.sources.x import X_GLOBAL_BASELINE, X_SOURCE_NAMES, XPlaywrightSource


async def init_baseline() -> None:
    """X Bookmarks/Likes 页面可见 tweet id → baseline（不 cubox）。"""
    configure_logging(settings.log_level)
    enabled = load_channels().enabled_sources()
    configs = {
        name: entry.config
        for name, entry in enabled.items()
        if name in X_SOURCE_NAMES and entry.config.get("credential_name")
    }
    if not configs:
        print("⚠️ channels.yaml 未启用 x_bookmarks/x_likes（需 credential_name），终止")
        return

    async with async_session_factory() as session:
        pool = BrowserPool()
        sm = LoginSessionManager(
            pool,
            CredentialVault(),
            CredentialRepo(session),
            LoginSessionRepo(session),
            {"x": XSessionLoginStrategy(pool)},
        )
        baseline = IncrementalBaselineRepo(session)
        source = XPlaywrightSource(configs, sm, pool, None, None, "", baseline)

        credential_name = next(iter(configs.values()))["credential_name"]
        storage_state = await sm.acquire("x", credential_name)
        ctx = await pool.context_for("x", storage_state)
        page = await ctx.new_page()
        try:
            tweets_by_source = await source.scrape_timelines(page)
        finally:
            await page.close()

        all_ids: set[str] = set()
        for source_name, tweets in tweets_by_source.items():
            ids = {tweet.id for tweet in tweets}
            known = await baseline.get_known(source_name)
            await baseline.save_known(source_name, known | ids)
            all_ids.update(ids)
            print(f"✓ {source_name} baseline：{len(ids)} 条")

        global_known = await baseline.get_known(X_GLOBAL_BASELINE)
        await baseline.save_known(X_GLOBAL_BASELINE, global_known | all_ids)
        print(f"✓ x 全局 baseline：{len(all_ids)} 条")
        print("完成：baseline 已填（不 cubox）。后续 worker collect 只推增量。")


if __name__ == "__main__":
    asyncio.run(init_baseline())
