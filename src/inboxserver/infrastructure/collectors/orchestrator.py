"""收集编排：API 源（telegram/dida）+ 浏览器源（zhihu/inoreader/bilibili/youtube）→ 入队。

run_collect 跑所有启用 source。浏览器源需 master_key + 凭据，缺失时跳过（不阻塞 API 源）。
P1-3：_collect_browser_sources 拆分为 _create_browser_deps + per-source collect（SRP）。
"""

from __future__ import annotations

from dataclasses import dataclass

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


@dataclass
class _BrowserDeps:
    """浏览器源共享依赖（_create_browser_deps 产出，各 source 共用）。"""

    sm: object  # LoginSessionManager
    pool: object  # BrowserPool
    baseline_repo: object  # IncrementalBaselineRepo
    llm_key: str


async def _create_browser_deps(channels: ChannelsConfig, session) -> _BrowserDeps | None:
    """创建浏览器源依赖（vault/repos/pool/strategies/session_manager）。

    无 master_key 或 import 失败返回 None（调用方跳过浏览器源）。
    """
    try:
        from inboxserver.infrastructure.browser.pool import BrowserPool
        from inboxserver.infrastructure.browser.session_manager import LoginSessionManager
        from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
        from inboxserver.infrastructure.persistence.repositories.baseline import (
            IncrementalBaselineRepo,
        )
        from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo
        from inboxserver.infrastructure.persistence.repositories.login_session import (
            LoginSessionRepo,
        )
        from inboxserver.plugins.login_strategies.bilibili import BilibiliCookieLoginStrategy
        from inboxserver.plugins.login_strategies.inoreader import InoreaderSessionLoginStrategy
        from inboxserver.plugins.login_strategies.youtube import YouTubeSessionLoginStrategy
        from inboxserver.plugins.login_strategies.zhihu import ZhihuCookieLoginStrategy

        vault = CredentialVault()
    except Exception:
        return None

    pool = BrowserPool()
    sm = LoginSessionManager(
        pool, vault, CredentialRepo(session), LoginSessionRepo(session),
        {
            "zhihu": ZhihuCookieLoginStrategy(pool),
            "inoreader": InoreaderSessionLoginStrategy(pool),
            "bilibili": BilibiliCookieLoginStrategy(pool),
            "youtube": YouTubeSessionLoginStrategy(pool),
        },
    )
    return _BrowserDeps(
        sm=sm, pool=pool,
        baseline_repo=IncrementalBaselineRepo(session),
        llm_key=channels.llm.get("glm_api_key", ""),
    )


async def _collect_browser_sources(
    channels: ChannelsConfig, http, queue_repo: RedisQueueRepository, session
) -> dict[str, dict]:
    """浏览器源编排：创建依赖 → fetch 源(zhihu/bili) + DOM 源(inoreader/yt) collect。"""
    enabled = channels.enabled_sources()
    if not any(name in enabled for name in _BROWSER_NAMES):
        return {}

    deps = await _create_browser_deps(channels, session)
    if deps is None:
        return {}

    results: dict[str, dict] = {}

    # fetch sources（zhihu/bilibili：Scraper fetch API）
    from inboxserver.infrastructure.browser.scraper import Scraper
    from inboxserver.plugins.login_strategies.bilibili import BILI_BASE
    from inboxserver.plugins.login_strategies.zhihu import ZHIHU_BASE
    from inboxserver.plugins.sources.bilibili import BilibiliSource
    from inboxserver.plugins.sources.zhihu import ZhihuSource

    for name, cls, base in [
        ("zhihu", ZhihuSource, ZHIHU_BASE),
        ("bilibili", BilibiliSource, BILI_BASE),
    ]:
        cfg = enabled.get(name)
        if cfg and cfg.config.get("credential_name"):
            scraper = Scraper(deps.pool, base)
            src = cls(
                cfg.config, deps.sm, scraper, queue_repo, http,
                deps.llm_key, deps.baseline_repo,
            )
            results[name] = _result_dict(await src.collect())

    # dom sources（inoreader/youtube：pool DOM 抓取）
    from inboxserver.plugins.sources.inoreader import InoreaderSource
    from inboxserver.plugins.sources.youtube import YouTubeSource

    for name, cls in [("inoreader", InoreaderSource), ("youtube", YouTubeSource)]:
        cfg = enabled.get(name)
        if cfg and cfg.config.get("credential_name"):
            src = cls(
                cfg.config, deps.sm, deps.pool, queue_repo, http,
                deps.llm_key, deps.baseline_repo,
            )
            results[name] = _result_dict(await src.collect())

    return results


def _result_dict(r: CollectResult) -> dict:
    return {"enqueued": r.enqueued, "skipped": r.skipped, "meta": r.meta}
