"""browser 源收集（zhihu/inoreader/bilibili/youtube）：在 worker（有 Xvfb+chromium）跑。

从 orchestrator 抽出（DRY）：server collect_job 不再调用（server 无 DISPLAY，chromium.launch
会崩），由 worker 定时调用。逻辑等价迁移自 orchestrator._collect_browser_sources。
"""

from __future__ import annotations

from dataclasses import dataclass

from inboxserver.config.channels import ChannelsConfig
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult

_BROWSER_NAMES = ("zhihu", "inoreader", "bilibili", "youtube")


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
        sm=sm,
        pool=pool,
        baseline_repo=IncrementalBaselineRepo(session),
        llm_key=channels.llm.get("glm_api_key", ""),
    )


def _result_dict(r: CollectResult) -> dict:
    return {"enqueued": r.enqueued, "skipped": r.skipped, "meta": r.meta}


async def collect_browser_sources(
    channels: ChannelsConfig, http, queue_repo: RedisQueueRepository, session
) -> dict[str, dict]:
    """浏览器源编排：创建依赖 → fetch 源(zhihu/bili) + DOM 源(inoreader/yt) collect。

    在 worker（有 Xvfb+chromium）调用；server 无 DISPLAY 不可调用（会崩在 chromium.launch）。
    """
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
