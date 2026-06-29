"""收集编排：API 源（telegram/dida/github_stars）→ 入队。

browser 源（zhihu/inoreader/bilibili/youtube）已抽到 browser_collector.py，在 worker
（有 Xvfb+chromium）跑——server 无 DISPLAY，不在此调用（会崩在 chromium.launch）。
"""

from __future__ import annotations

from inboxserver.config.channels import ChannelsConfig
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult


async def run_collect(channels: ChannelsConfig, http, queue_redis, session) -> dict[str, dict]:
    """跑启用的 API 源（telegram/dida/github_stars）collect，返回每个 source 结果摘要。

    browser 源由 worker 定时跑（browser_collector.collect_browser_sources），不在 server。
    """
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

        dida_src = DidaSource(
            enabled["dida"].config, http, queue_repo, DidaSyncStateRepo(session)
        )
        results["dida"] = _result_dict(await dida_src.collect())

    if "github_stars" in enabled and enabled["github_stars"].config.get("token"):
        from inboxserver.infrastructure.persistence.repositories.baseline import (
            IncrementalBaselineRepo,
        )
        from inboxserver.plugins.sources.github_stars import GitHubStarsSource

        github_src = GitHubStarsSource(
            enabled["github_stars"].config,
            http,
            queue_repo,
            IncrementalBaselineRepo(session),
        )
        results["github_stars"] = _result_dict(await github_src.collect())

    return results


def _result_dict(r: CollectResult) -> dict:
    return {"enqueued": r.enqueued, "skipped": r.skipped, "meta": r.meta}
