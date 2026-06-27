"""APScheduler：定时收集（每 60min）+ 汇总通知。

collect_job：加载 channels → orchestrator 跑启用的 source → 汇总结果 → notify
（EmailNotifier 若开启，否则 LogNotifier）。无新内容不发（对齐 inbox_sync）。
"""

from __future__ import annotations

import redis.asyncio as aioredis
import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from inboxserver.config.channels import load_channels
from inboxserver.config.settings import settings
from inboxserver.infrastructure.collectors.orchestrator import run_collect
from inboxserver.infrastructure.http_client import make_http_client
from inboxserver.infrastructure.persistence.db import async_session_factory
from inboxserver.notifications.email_notifier import EmailNotifier
from inboxserver.notifications.log_notifier import LogNotifier
from inboxserver.notifications.telegram_notifier import TelegramNotifier


async def collect_job() -> None:
    """定时收集：跑启用的 source.collect，汇总后 notify。"""
    channels = load_channels()
    if not channels.enabled_sources():
        return  # 无启用 source，跳过
    http = make_http_client()
    queue_redis = aioredis.from_url(settings.redis_url)
    try:
        async with async_session_factory() as session:
            results = await run_collect(channels, http, queue_redis, session)
        await _notify_results(results, channels, http)
    except Exception as e:
        structlog.get_logger().error("scheduler collect failed", error=repr(e))
    finally:
        await http.aclose()
        await queue_redis.aclose()


def _summarize(results: dict) -> str:
    """汇总各 source 结果 → 文本（对齐 inbox_sync 汇总报告风格）。"""
    lines = ["📬 收件箱同步报告"]
    for source, r in results.items():
        enq = r.get("enqueued", {})
        if enq:
            parts = [f"{k} {v} 条" for k, v in enq.items()]
            lines.append(f"  {source}: {', '.join(parts)}")
    return "\n".join(lines)


async def _notify_results(results: dict, channels, http) -> None:
    """有新内容才 notify（对齐 inbox_sync total_action>0 才发）。

    双通道：Email（settings.smtp_*，凭据齐全才发，否则 LogNotifier 兜底）
    + Telegram（复用 telegram source bot_token + channels.notification.telegram_chat_id）。
    任一通道未配置或失败均不阻塞主流程。
    """
    total = sum(sum(r.get("enqueued", {}).values()) for r in results.values())
    if total == 0:
        return
    summary = _summarize(results)

    # Email 通道：email_enabled 且 smtp 凭据齐全才真发，否则 LogNotifier 兜底
    if settings.email_enabled and settings.smtp_user and settings.smtp_pass:
        await EmailNotifier().notify(summary)
    else:
        await LogNotifier().notify(summary)

    # Telegram 通道：复用 telegram source 的 bot_token + notification.telegram_chat_id
    tg_cfg = channels.sources.get("telegram")
    tg_token = tg_cfg.config.get("bot_token", "") if tg_cfg else ""
    tg_chat = channels.notification.get("telegram_chat_id", "")
    if tg_token and tg_chat:
        await TelegramNotifier(tg_token, tg_chat, http).notify(summary)


def setup_scheduler() -> AsyncIOScheduler:
    """创建 scheduler：每 60min 跑 collect_job（max_instances=1 防重叠，coalesce 合并积压）。"""
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        collect_job,
        "interval",
        minutes=60,
        id="collect",
        max_instances=1,
        coalesce=True,
    )
    return scheduler
