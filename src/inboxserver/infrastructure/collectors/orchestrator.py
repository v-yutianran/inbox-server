"""收集编排：根据 channels config 创建启用的 source 实例 → collect → 汇总。

MVP：telegram/dida（API 源）。知乎（浏览器源）需 session_manager/vault/scraper 等，
依赖注入复杂，留待后续（TODO）。
"""

from __future__ import annotations

from inboxserver.config.channels import ChannelsConfig
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult


async def run_collect(channels: ChannelsConfig, http, queue_redis, session) -> dict[str, dict]:
    """跑所有启用 source 的 collect，返回每个 source 的结果摘要。"""
    queue_repo = RedisQueueRepository(queue_redis)
    enabled = channels.enabled_sources()
    results: dict[str, dict] = {}

    # Telegram（API 源）
    if "telegram" in enabled and enabled["telegram"].config.get("bot_token"):
        from inboxserver.infrastructure.persistence.repositories.telegram_offset import (
            TelegramOffsetRepo,
        )
        from inboxserver.plugins.sources.telegram import TelegramSource

        src = TelegramSource(
            enabled["telegram"].config, http, queue_repo, TelegramOffsetRepo(session)
        )
        results["telegram"] = _result_dict(await src.collect())

    # 滴答（API 源）
    if "dida" in enabled and enabled["dida"].config.get("access_token"):
        from inboxserver.infrastructure.persistence.repositories.dida_sync_state import (
            DidaSyncStateRepo,
        )
        from inboxserver.plugins.sources.dida import DidaSource

        src = DidaSource(enabled["dida"].config, http, queue_repo, DidaSyncStateRepo(session))
        results["dida"] = _result_dict(await src.collect())

    # 知乎（浏览器源）：TODO — 需 session_manager/vault/scraper/baseline_repo 编排
    return results


def _result_dict(r: CollectResult) -> dict:
    return {"enqueued": r.enqueued, "skipped": r.skipped, "meta": r.meta}
