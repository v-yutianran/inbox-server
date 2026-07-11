"""X source 单测：解析 tweet、合并收藏/喜欢标签、按全局 tweet id 去重。"""

from __future__ import annotations

from unittest.mock import AsyncMock, call

import pytest

from inboxserver.plugins.sources.x import XPlaywrightSource, XTweet, build_x_payload, parse_x_tweets


@pytest.fixture
def source():
    return XPlaywrightSource(
        {
            "x_bookmarks": {"credential_name": "x_creds"},
            "x_likes": {"credential_name": "x_creds", "username": "alice"},
        },
        session_manager=AsyncMock(),
        pool=AsyncMock(),
        queue_repo=AsyncMock(),
        http=AsyncMock(),
        llm_api_key="",
        baseline_repo=AsyncMock(),
    )


def test_parse_x_tweets_normalizes_and_skips_invalid():
    raw = [
        {
            "url": "https://x.com/alice/status/1234567890?s=20",
            "author": "Alice   @alice",
            "text": "hello\nworld",
        },
        {"id": "1234567890", "url": "https://x.com/alice/status/1234567890"},
        {"url": "https://x.com/alice"},
    ]

    tweets = parse_x_tweets(raw)

    assert tweets == [
        XTweet(
            id="1234567890",
            url="https://x.com/alice/status/1234567890",
            author="Alice @alice",
            text="hello world",
        )
    ]


def test_build_x_payload_keeps_source_tags():
    payload = build_x_payload(
        XTweet("1", "https://x.com/alice/status/1", "Alice", "一条推文"),
        ["x-bookmarks", "x-likes"],
    )

    assert payload == {
        "url": "https://x.com/alice/status/1",
        "title": "Alice: 一条推文",
        "tags": ["x", "x-bookmarks", "x-likes"],
    }


async def test_scrape_timelines_does_not_wait_for_network_idle(source):
    page = AsyncMock()
    page.url = "https://x.com/i/bookmarks"
    source._scrape_timeline = AsyncMock(return_value=[])

    await source.scrape_timelines(page)

    assert page.goto.await_args_list == [
        call("https://x.com/i/bookmarks", wait_until="domcontentloaded"),
        call("https://x.com/alice/likes", wait_until="domcontentloaded"),
    ]


async def test_collect_merges_bookmarks_and_likes_for_same_tweet(source):
    tweet = XTweet("1", "https://x.com/alice/status/1", "Alice", "hello")
    source._session.acquire.return_value = {"cookies": []}
    page = AsyncMock()
    source._pool.context_for.return_value = AsyncMock(new_page=AsyncMock(return_value=page))
    source.scrape_timelines = AsyncMock(
        return_value={"x_bookmarks": [tweet], "x_likes": [tweet]}
    )
    source._baseline.get_known.side_effect = [set(), set(), set()]

    result = await source.collect()

    assert source._queue.enqueue.await_count == 1
    payload = source._queue.enqueue.await_args.args[1]
    assert payload["url"] == "https://x.com/alice/status/1"
    assert payload["tags"] == ["x", "x-bookmarks", "x-likes"]
    assert result["x_bookmarks"].enqueued == {"link": 1}
    assert result["x_likes"].enqueued == {"link": 1}


async def test_collect_skips_globally_known_tweet(source):
    tweet = XTweet("1", "https://x.com/alice/status/1", "Alice", "hello")
    source._session.acquire.return_value = {"cookies": []}
    page = AsyncMock()
    source._pool.context_for.return_value = AsyncMock(new_page=AsyncMock(return_value=page))
    source.scrape_timelines = AsyncMock(return_value={"x_bookmarks": [tweet]})
    source._baseline.get_known.side_effect = [{"1"}, set()]

    result = await source.collect()

    source._queue.enqueue.assert_not_called()
    assert result["x_bookmarks"].enqueued == {}
    assert result["x_bookmarks"].skipped == 1


async def test_collect_returns_error_when_session_missing(source):
    source._session.acquire.side_effect = RuntimeError("凭据不存在")

    result = await source.collect()

    assert "error" in (result["x_bookmarks"].meta or {})
    assert "error" in (result["x_likes"].meta or {})
