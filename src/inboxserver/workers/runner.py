"""worker runner：三队列并发消费（asyncio.gather）+ graceful shutdown（SIGTERM/SIGINT）。

独立进程入口：python -m inboxserver.workers.runner
"""

from __future__ import annotations

import asyncio
import os
import signal
from collections.abc import Callable
from contextlib import suppress
from datetime import UTC, datetime

import httpx
import redis.asyncio as aioredis
import structlog

from inboxserver.config.channels import load_channels
from inboxserver.config.logging import configure_logging
from inboxserver.config.settings import settings
from inboxserver.domain.models import ItemKind, QueueLimits
from inboxserver.domain.policy.article_archive import url_fingerprint
from inboxserver.domain.policy.tags import fmt_cubox_tags, fmt_flomo_tags
from inboxserver.infrastructure.article_archive.defuddle import DefuddleBridge
from inboxserver.infrastructure.article_archive.fetcher import DirectHtmlFetcher
from inboxserver.infrastructure.article_archive.git_repository import GitArticleRepository
from inboxserver.infrastructure.article_archive.service import ArticleArchiveService
from inboxserver.infrastructure.browser.playwright_runtime import fetch_rendered_html
from inboxserver.infrastructure.destinations.dispatcher import build_destinations
from inboxserver.infrastructure.http_client import make_http_client
from inboxserver.infrastructure.llm import generate_smart_tags
from inboxserver.infrastructure.operations.heartbeat import worker_heartbeat_loop
from inboxserver.infrastructure.persistence.db import async_session_factory
from inboxserver.infrastructure.persistence.repositories.article_archive_event import (
    ArticleArchiveEventRepo,
)
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.workers.consumer import consume

log = structlog.get_logger(__name__)


# 限速常量：window_count=0 表示禁用固定窗口；link 仅保留每日 500 条上限。
LIMITS: dict[ItemKind, QueueLimits] = {
    ItemKind.LINK: QueueLimits(window_count=0, window_sec=21600, daily_limit=500, interval=5),
    ItemKind.TEXT: QueueLimits(window_count=25, window_sec=21600, daily_limit=96, interval=10),
    ItemKind.FILE: QueueLimits(window_count=1400, window_sec=1800, daily_limit=None, interval=1),
}


async def _enqueue_article_archive(
    queue_repo: RedisQueueRepository,
    payload: dict,
    *,
    attempts: int,
    delay_seconds: float,
) -> bool:
    """Cubox 成功后的有界入队；失败仅告警，不反转 Cubox 结果。"""
    for attempt in range(1, attempts + 1):
        try:
            await queue_repo.enqueue(ItemKind.ARTICLE, payload)
            return True
        except Exception as error:
            if attempt < attempts:
                await asyncio.sleep(delay_seconds * attempt)
                continue
            log.error(
                "article_archive_enqueue_failed",
                url_fingerprint=url_fingerprint(str(payload.get("url") or "")),
                attempts=attempts,
                error_type=type(error).__name__,
            )
    return False


def _make_process_link(
    http,
    cubox,
    llm_key,
    *,
    queue_repo: RedisQueueRepository | None = None,
    archive_enabled: bool = False,
    archive_enqueue_attempts: int = 3,
    archive_enqueue_delay: float = 0.25,
    archive_clock: Callable[[], datetime] | None = None,
):
    """link 消费处理：无标签时现场调 GLM 生成智能标签 + github 来源标签，再 dispatch。

    标签在消费时（限速后）生成，避免入队洪峰瞬间打爆 GLM（对齐 inbox_dispatcher.worker）。
    """

    async def process(item):
        url = item.get("url", "")
        if not item.get("tags"):
            tags = await generate_smart_tags(http, item.get("title") or url, llm_key)
            item["tags"] = fmt_cubox_tags(tags, is_github="github.com" in url)
        result = await cubox.dispatch(item)
        if (
            result[1] is DispatchOutcome.OK
            and archive_enabled
            and queue_repo is not None
            and url
        ):
            clock = archive_clock or (lambda: datetime.now(UTC))
            await _enqueue_article_archive(
                queue_repo,
                {
                    "url": url,
                    "title": str(item.get("title") or ""),
                    "tags": list(item.get("tags") or []),
                    "requested_at": clock().isoformat(),
                },
                attempts=archive_enqueue_attempts,
                delay_seconds=archive_enqueue_delay,
            )
        return result

    return process


def _article_limits(config) -> QueueLimits:
    """从文章归档配置生成独立限速策略。"""
    return QueueLimits(
        window_count=config.rate_window_count,
        window_sec=config.rate_window_seconds,
        daily_limit=config.daily_limit,
        interval=config.interval_seconds,
    )


def _build_article_archive_service(channels, http) -> ArticleArchiveService:
    """使用仓库内 Defuddle、headed Playwright 和本地 Git 仓库构建归档服务。"""
    config = channels.article_archive
    bridge = DefuddleBridge(
        timeout_seconds=config.defuddle_timeout_seconds,
        max_input_bytes=config.max_html_bytes,
        max_output_bytes=config.max_output_bytes,
    )

    async def browser_fetch(url: str) -> str:
        return await fetch_rendered_html(
            url,
            timeout_seconds=config.browser_timeout_seconds,
            max_html_bytes=config.max_html_bytes,
        )

    async def record_event(**event) -> None:
        async with async_session_factory() as session:
            await ArticleArchiveEventRepo(session).record(**event)

    return ArticleArchiveService(
        fetcher=DirectHtmlFetcher(
            http,
            timeout_seconds=config.http_timeout_seconds,
            max_html_bytes=config.max_html_bytes,
        ),
        bridge=bridge,
        browser_fetch=browser_fetch,
        repository=GitArticleRepository(
            config.repository_dir,
            articles_dir=config.articles_dir,
            github_token=os.environ.get("GITHUB_TOKEN"),
        ),
        event_recorder=record_event,
        min_visible_characters=config.min_visible_characters,
    )


def _make_process_text(http, flomo, llm_key):
    """text 消费处理：无标签时调 GLM 生成智能标签 + fmt_flomo_tags 拼 #前缀，再 dispatch。

    对齐老 dispatcher process_text（总是生成标签）；GLM 失败兜底为不加前缀（不阻塞）。
    标签在消费时（限速后）生成，避免入队洪峰打爆 GLM（对齐 inbox_dispatcher.worker）。
    """

    async def process(item):
        content = item.get("content", "")
        if not item.get("tags"):
            tags = await generate_smart_tags(http, content, llm_key)
            if tags:
                # flomo 标签前缀：'#标签1 #标签2 内容'
                item["content"] = f"{fmt_flomo_tags(tags)} {content}"
        return await flomo.dispatch(item)

    return process


async def _browser_collect_loop(channels, http, queue_repo, stop_event):
    """worker 定时 browser collect（每 60min），复用 worker 闲置的 chromium+Xvfb。

    browser 源 collect 必须在有 DISPLAY 的 worker 跑（server 无 DISPLAY 会崩在 chromium.launch）。
    异常隔离：collect 失败仅告警，不影响消费循环。graceful：stop_event 可立即中断等待。
    """
    from inboxserver.infrastructure.collectors.browser_collector import collect_browser_sources
    from inboxserver.infrastructure.persistence.db import async_session_factory

    while not stop_event.is_set():
        try:
            # P2-9：绑定 component（collect 内部 + 结果日志自动带，merge_contextvars）。
            # bound_contextvars 退出自动清理，防上下文跨循环泄漏。
            with structlog.contextvars.bound_contextvars(component="browser_collect"):
                async with async_session_factory() as session:
                    results = await collect_browser_sources(channels, http, queue_repo, session)
                if results:
                    log.info(
                        "browser_collected",
                        enqueued={k: v.get("enqueued") for k, v in results.items()},
                    )
        except Exception as e:
            # browser collect 失败不阻塞消费（附加能力，仅告警）
            log.warning("browser_collect_failed", error=repr(e))
        # 等下次（60min；stop_event 立即中断以 graceful shutdown）
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop_event.wait(), timeout=3600)


async def run_worker() -> None:
    """启动三队列并发消费。link 走智能标签增强，text/file 直接 dispatch。

    SIGTERM/SIGINT → stop_event.set() → consumer graceful shutdown（_interruptible_sleep 中断）。
    """
    channels = load_channels()
    http: httpx.AsyncClient = make_http_client()
    queue_redis = aioredis.from_url(settings.redis_url)
    queue_repo = RedisQueueRepository(queue_redis)
    dedup = DedupStore(queue_redis)
    rate = RateGuard(queue_redis)
    dests = build_destinations(channels, http)
    if not dests:
        log.warning("worker_no_destinations_exit")
        return
    article_service = (
        _build_article_archive_service(channels, http)
        if channels.article_archive.enabled
        else None
    )
    log.info(
        "worker_started",
        destinations=[kind.value for kind in dests],
        article_archive=article_service is not None,
    )
    llm_key = channels.llm.get("glm_api_key", "")

    # graceful shutdown 信号
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)

    tasks = []
    for kind in dests:
        lim = LIMITS[kind]
        if kind is ItemKind.LINK:
            process_fn = _make_process_link(
                http,
                dests[kind],
                llm_key,
                queue_repo=queue_repo,
                archive_enabled=article_service is not None,
                archive_enqueue_attempts=channels.article_archive.enqueue_attempts,
            )
        elif kind is ItemKind.TEXT:
            process_fn = _make_process_text(http, dests[kind], llm_key)
        else:
            process_fn = dests[kind].dispatch
        tasks.append(
            consume(
                kind, queue_repo, dedup, rate, process_fn, kind.value,
                limits=lim,
                stop_event=stop_event,
            )
        )
    if article_service is not None:
        tasks.append(
            consume(
                ItemKind.ARTICLE,
                queue_repo,
                dedup,
                rate,
                article_service.process,
                ItemKind.ARTICLE.value,
                limits=_article_limits(channels.article_archive),
                stop_event=stop_event,
            )
        )
    # browser collect 定时（worker 有 Xvfb+chromium；
    # 无 browser 源时 collect_browser_sources 内部跳过）
    tasks.append(_browser_collect_loop(channels, http, queue_repo, stop_event))
    tasks.append(worker_heartbeat_loop(queue_redis, stop_event))
    await asyncio.gather(*tasks)


def main() -> None:
    configure_logging(settings.log_level)
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
