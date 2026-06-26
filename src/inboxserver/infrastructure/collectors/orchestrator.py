"""收集编排：API 源（telegram/dida）+ 浏览器源（zhihu/inoreader/bilibili/youtube）→ 入队。

run_collect 跑所有启用 source。浏览器源需 master_key + 凭据，缺失时跳过（不阻塞 API 源）。
"""

from __future__ import annotations

from inboxserver.config.channels import ChannelsConfig
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult

_BROWSER_NAMES = ("zhihu", "inoreader", "bilibili", "youtube")


async def run_collect(channels: ChannelsConfig, http, queue_redis, session) -> dict[str, dict]:
    """跑所有启用 source 的 collect，返回每个 source 的结果摘要。"""
    queue_repo = RedisQueueRepository(queue_redis)
    enabled = channels.enabled_sources()
    results: dict[str, dict] = {}

    # ── API 源 ──
    if "telegram" in enabled and enabled["telegram"].config.get("bot_token"):
        from inboxserver.infrastructure.persistence.repositories.telegram_offset import (
            TelegramOffsetRepo,
        )
        from inboxserver.plugins.sources.telegram import TelegramSource

        src = TelegramSource(
            enabled["telegram"].config, http, queue_repo, TelegramOffsetRepo(session)
        )
        results["telegram"] = _result_dict(await src.collect())

    if "dida" in enabled and enabled["dida"].config.get("access_token"):
        from inboxserver.infrastructure.persistence.repositories.dida_sync_state import (
            DidaSyncStateRepo,
        )
        from inboxserver.plugins.sources.dida import DidaSource

        src = DidaSource(enabled["dida"].config, http, queue_repo, DidaSyncStateRepo(session))
        results["dida"] = _result_dict(await src.collect())

    # ── 浏览器源 ──
    results.update(await _collect_browser_sources(channels, http, queue_repo, session))
    return results


async def _collect_browser_sources(
    channels: ChannelsConfig, http, queue_repo: RedisQueueRepository, session
) -> dict[str, dict]:
    """浏览器源编排：创建 session_manager/scraper/vault + 启用的浏览器源 collect。

    无 master_key 或凭据缺失时跳过（不阻塞 API 源）。zhihu/bilibili 用 Scraper（fetch API），
    inoreader/youtube 用 pool（DOM 抓取）。
    """
    enabled = channels.enabled_sources()
    if not any(name in enabled for name in _BROWSER_NAMES):
        return {}

    try:
        from inboxserver.infrastructure.browser.pool import BrowserPool
        from inboxserver.infrastructure.browser.scraper import Scraper
        from inboxserver.infrastructure.browser.session_manager import LoginSessionManager
        from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
        from inboxserver.infrastructure.persistence.repositories.baseline import (
            IncrementalBaselineRepo,
        )
        from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo
        from inboxserver.infrastructure.persistence.repositories.login_session import (
            LoginSessionRepo,
        )
        from inboxserver.plugins.login_strategies.bilibili import (
            BILI_BASE,
            BilibiliCookieLoginStrategy,
        )
        from inboxserver.plugins.login_strategies.inoreader import (
            InoreaderSessionLoginStrategy,
        )
        from inboxserver.plugins.login_strategies.youtube import (
            YouTubeSessionLoginStrategy,
        )
        from inboxserver.plugins.login_strategies.zhihu import (
            ZHIHU_BASE,
            ZhihuCookieLoginStrategy,
        )
        from inboxserver.plugins.sources.bilibili import BilibiliSource
        from inboxserver.plugins.sources.inoreader import InoreaderSource
        from inboxserver.plugins.sources.youtube import YouTubeSource
        from inboxserver.plugins.sources.zhihu import ZhihuSource

        vault = CredentialVault()
    except Exception:
        return {}  # 无 master_key 或依赖缺失，跳过浏览器源

    cred_repo = CredentialRepo(session)
    session_repo = LoginSessionRepo(session)
    baseline_repo = IncrementalBaselineRepo(session)
    pool = BrowserPool()
    strategies = {
        "zhihu": ZhihuCookieLoginStrategy(pool),
        "inoreader": InoreaderSessionLoginStrategy(pool),
        "bilibili": BilibiliCookieLoginStrategy(pool),
        "youtube": YouTubeSessionLoginStrategy(pool),
    }
    sm = LoginSessionManager(pool, vault, cred_repo, session_repo, strategies)
    llm_key = channels.llm.get("glm_api_key", "")
    results: dict[str, dict] = {}

    # zhihu/bilibili：Scraper（fetch API）；inoreader/youtube：pool（DOM）
    _fetch_sources = {
        "zhihu": (ZhihuSource, ZHIHU_BASE),
        "bilibili": (BilibiliSource, BILI_BASE),
    }
    _dom_sources = {
        "inoreader": InoreaderSource,
        "youtube": YouTubeSource,
    }

    for name, (cls, base) in _fetch_sources.items():
        if name not in enabled:
            continue
        cfg = enabled[name].config
        if not cfg.get("credential_name"):
            continue
        try:
            scraper = Scraper(pool, base)
            src = cls(cfg, sm, scraper, queue_repo, http, llm_key, baseline_repo)
            results[name] = _result_dict(await src.collect())
        except Exception as e:
            results[name] = {"error": repr(e)}

    for name, cls in _dom_sources.items():
        if name not in enabled:
            continue
        cfg = enabled[name].config
        if not cfg.get("credential_name"):
            continue
        try:
            src = cls(cfg, sm, pool, queue_repo, http, llm_key, baseline_repo)
            results[name] = _result_dict(await src.collect())
        except Exception as e:
            results[name] = {"error": repr(e)}

    return results


def _result_dict(r: CollectResult) -> dict:
    return {"enqueued": r.enqueued, "skipped": r.skipped, "meta": r.meta}
