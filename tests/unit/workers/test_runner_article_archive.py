"""Cubox 成功后的独立文章归档入队测试。"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import inboxserver.workers.runner as runner
from inboxserver.config.channels import ArticleArchiveConfig, ChannelEntry, ChannelsConfig
from inboxserver.domain.models import ItemKind
from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.workers.runner import _make_process_link


def _clock() -> datetime:
    return datetime(2026, 7, 16, 8, tzinfo=UTC)


def test_build_archive_service_uses_git_repository_without_jianguoyun(monkeypatch) -> None:
    channels = ChannelsConfig(
        article_archive=ArticleArchiveConfig(
            enabled=True,
            repository_dir="/article-repository",
            articles_dir="references/article",
        )
    )
    repository = object()
    captured: dict = {}
    repository_config: dict = {}

    def build_repository(*args, **kwargs):
        repository_config.update({"args": args, "kwargs": kwargs})
        return repository

    monkeypatch.setenv("GITHUB_TOKEN", "test-token")
    monkeypatch.setattr(runner, "GitArticleRepository", build_repository)
    monkeypatch.setattr(runner, "DefuddleBridge", lambda **kwargs: object())
    monkeypatch.setattr(runner, "DirectHtmlFetcher", lambda *args, **kwargs: object())
    monkeypatch.setattr(
        runner,
        "ArticleArchiveService",
        lambda **kwargs: captured.update(kwargs) or object(),
    )

    runner._build_article_archive_service(channels, AsyncMock())

    assert captured["repository"] is repository
    assert "webdav" not in captured
    assert repository_config == {
        "args": ("/article-repository",),
        "kwargs": {
            "articles_dir": "references/article",
            "github_token": "test-token",
        },
    }


async def test_cubox_ok_enqueues_article_with_final_tags() -> None:
    cubox = AsyncMock()
    cubox.dispatch.return_value = (True, DispatchOutcome.OK)
    queue = AsyncMock()
    process = _make_process_link(
        AsyncMock(),
        cubox,
        "",
        queue_repo=queue,
        archive_enabled=True,
        archive_clock=_clock,
        archive_enqueue_delay=0,
    )

    result = await process(
        {"url": "https://example.com/a", "title": "文章", "tags": ["AI", "效率"]}
    )

    assert result == (True, DispatchOutcome.OK)
    queue.enqueue.assert_awaited_once()
    kind, payload = queue.enqueue.await_args.args
    assert kind is ItemKind.ARTICLE
    assert payload == {
        "url": "https://example.com/a",
        "title": "文章",
        "tags": ["AI", "效率"],
        "requested_at": "2026-07-16T08:00:00+00:00",
    }


async def test_cubox_fail_quota_or_exception_does_not_enqueue_article() -> None:
    for outcome in (DispatchOutcome.FAIL, DispatchOutcome.QUOTA):
        cubox = AsyncMock()
        cubox.dispatch.return_value = (False, outcome)
        queue = AsyncMock()
        process = _make_process_link(
            AsyncMock(), cubox, "", queue_repo=queue, archive_enabled=True
        )
        assert await process({"url": "https://example.com/a", "tags": ["AI"]}) == (
            False,
            outcome,
        )
        queue.enqueue.assert_not_awaited()

    cubox = AsyncMock()
    cubox.dispatch.side_effect = RuntimeError("cubox failed")
    queue = AsyncMock()
    process = _make_process_link(
        AsyncMock(), cubox, "", queue_repo=queue, archive_enabled=True
    )
    try:
        await process({"url": "https://example.com/a", "tags": ["AI"]})
    except RuntimeError:
        pass
    queue.enqueue.assert_not_awaited()


async def test_archive_enqueue_retries_but_keeps_cubox_success() -> None:
    cubox = AsyncMock()
    cubox.dispatch.return_value = (True, DispatchOutcome.OK)
    queue = AsyncMock()
    queue.enqueue.side_effect = RuntimeError("redis unavailable")
    process = _make_process_link(
        AsyncMock(),
        cubox,
        "",
        queue_repo=queue,
        archive_enabled=True,
        archive_enqueue_attempts=3,
        archive_enqueue_delay=0,
        archive_clock=_clock,
    )

    result = await process({"url": "https://example.com/a", "tags": ["AI"]})

    assert result == (True, DispatchOutcome.OK)
    assert queue.enqueue.await_count == 3
    cubox.dispatch.assert_awaited_once()


async def test_archive_disabled_keeps_existing_link_behavior() -> None:
    cubox = AsyncMock()
    cubox.dispatch.return_value = (True, DispatchOutcome.OK)
    queue = AsyncMock()
    process = _make_process_link(
        AsyncMock(), cubox, "", queue_repo=queue, archive_enabled=False
    )

    assert await process({"url": "https://example.com/a", "tags": ["AI"]}) == (
        True,
        DispatchOutcome.OK,
    )
    queue.enqueue.assert_not_awaited()


async def test_run_worker_disabled_does_not_start_article_consumer(monkeypatch) -> None:
    channels = ChannelsConfig(
        destinations={
            "cubox": ChannelEntry(
                enabled=True,
                item_kind="link",
                config={"api_url": "https://cubox.example/api"},
            )
        }
    )
    cubox = AsyncMock()
    monkeypatch.setattr(runner, "load_channels", lambda: channels)
    monkeypatch.setattr(runner, "make_http_client", lambda: AsyncMock())
    monkeypatch.setattr(runner.aioredis, "from_url", lambda _: object())
    monkeypatch.setattr(runner, "RedisQueueRepository", lambda _: AsyncMock())
    monkeypatch.setattr(runner, "DedupStore", lambda _: AsyncMock())
    monkeypatch.setattr(runner, "RateGuard", lambda _: AsyncMock())
    monkeypatch.setattr(runner, "build_destinations", lambda *_: {ItemKind.LINK: cubox})
    build_archive = AsyncMock()
    monkeypatch.setattr(runner, "_build_article_archive_service", build_archive)
    consume = AsyncMock()
    monkeypatch.setattr(runner, "consume", consume)
    monkeypatch.setattr(runner, "_browser_collect_loop", AsyncMock())

    await runner.run_worker()

    build_archive.assert_not_called()
    assert consume.await_count == 1
    assert consume.call_args.args[0] is ItemKind.LINK
