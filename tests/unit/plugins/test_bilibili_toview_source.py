"""bilibili 稀后再看 source 单测：mock session/scraper(fetch) → parse toview API → 增量入队。"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

from inboxserver.plugins.sources.bilibili_toview import parse_bilibili_toview


def test_parse_bilibili_toview():
    body = json.dumps(
        {"data": {"list": [{"bvid": "BV1xx", "title": "视频A"}, {"bvid": "BV2yy", "title": "B"}]}}
    )
    items = parse_bilibili_toview(body)
    assert len(items) == 2
    assert items[0].url == "https://www.bilibili.com/video/BV1xx"
    assert items[0].title == "视频A"


def test_parse_toview_invalid_json():
    assert parse_bilibili_toview("not json") == []
    assert parse_bilibili_toview('{"data":{}}') == []


async def test_collect_toview_via_scraper_and_dedup():
    from inboxserver.plugins.sources.bilibili_toview import BilibiliToviewSource

    real = BilibiliToviewSource(
        {"credential_name": "bili_creds"},
        session_manager=AsyncMock(),
        scraper=AsyncMock(),
        queue_repo=AsyncMock(),
        http=AsyncMock(),
        llm_api_key="k",
        baseline_repo=AsyncMock(),
    )
    real._session.acquire.return_value = {"cookies": []}
    real._scraper.fetch_via_page.return_value = {
        "status": 200,
        "body": json.dumps({"data": {"list": [{"bvid": "BV1", "title": "X"}]}}),
    }
    real._baseline.get_known.return_value = set()
    real._http.post.return_value.json.return_value = {"choices": [{"message": {"content": "t1,t2"}}]}

    result = await real.collect()

    assert result.enqueued == {"link": 1}
    payload = real._queue.enqueue.await_args.args[1]
    assert payload["url"] == "https://www.bilibili.com/video/BV1"
    # baseline 用 bilibili_toview（独立于 bilibili fav）
    real._baseline.save_known.assert_called_once()
    assert real._baseline.save_known.await_args.args[0] == "bilibili_toview"


async def test_collect_toview_skips_known():
    """已 known 的 toview 不入队（增量去重）。"""
    from inboxserver.plugins.sources.bilibili_toview import BilibiliToviewSource

    real = BilibiliToviewSource(
        {"credential_name": "bili_creds"},
        session_manager=AsyncMock(),
        scraper=AsyncMock(),
        queue_repo=AsyncMock(),
        http=AsyncMock(),
        llm_api_key="k",
        baseline_repo=AsyncMock(),
    )
    real._session.acquire.return_value = {"cookies": []}
    real._scraper.fetch_via_page.return_value = {
        "status": 200,
        "body": json.dumps({"data": {"list": [{"bvid": "BV1", "title": "X"}]}}),
    }
    # baseline 已有 BV1 → 无新
    real._baseline.get_known.return_value = {"https://www.bilibili.com/video/BV1"}

    result = await real.collect()

    assert result.enqueued == {}  # 无新，不入队
    real._queue.enqueue.assert_not_called()
