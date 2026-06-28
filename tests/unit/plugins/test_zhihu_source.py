"""知乎来源测试：解析纯函数 + collect（入队/增量去重/401 重登）。"""

import json
from unittest.mock import AsyncMock

import pytest

from inboxserver.infrastructure.browser.scraper import LoginExpired
from inboxserver.plugins.sources.zhihu import ZhihuSource, parse_zhihu_collections


def test_parse_extracts_bookmarks():
    body = json.dumps(
        {"data": [{"content": {"url": "u1", "title": "t1"}}, {"content": {"url": "u2"}}]}
    )
    items = parse_zhihu_collections(body)
    assert len(items) == 2
    assert items[0].url == "u1"
    assert items[1].title == "u2"  # title 缺失回退 url


def test_parse_answer_uses_question_title():
    """answer 类型：标题取 question.title（不回退 url）"""
    body = json.dumps(
        {"data": [{"content": {"type": "answer", "url": "u1", "question": {"title": "问题标题"}}}]}
    )
    items = parse_zhihu_collections(body)
    assert items[0].title == "问题标题"


def test_parse_article_uses_content_title():
    """article 类型：标题取 content.title"""
    body = json.dumps({"data": [{"content": {"type": "article", "url": "u2", "title": "文章标题"}}]})
    items = parse_zhihu_collections(body)
    assert items[0].title == "文章标题"


def test_parse_invalid_json_returns_empty():
    assert parse_zhihu_collections("not json") == []
    assert parse_zhihu_collections("") == []


@pytest.fixture
def source():
    return ZhihuSource(
        {"credential_name": "zhihu_creds", "collection_id": "col123"},
        session_manager=AsyncMock(),
        scraper=AsyncMock(),
        queue_repo=AsyncMock(),
        http=AsyncMock(),
        llm_api_key="key",
        baseline_repo=AsyncMock(),
    )


async def test_collect_enqueues_new_with_tags(source):
    data = {
        "data": [
            {"content": {"url": "u1", "title": "t1"}},
            {"content": {"url": "u2", "title": "t2"}},
        ],
        "paging": {"is_end": True},
    }
    body = json.dumps(data)
    source._scraper.fetch_via_page.return_value = {"status": 200, "body": body}
    source._session.acquire.return_value = {"cookies": []}
    source._baseline.get_known.return_value = set()
    source._http.post.return_value.json.return_value = {
        "choices": [{"message": {"content": "标签A,标签B"}}]
    }

    result = await source.collect()

    assert result.enqueued == {"link": 2}
    assert source._queue.enqueue.await_count == 2
    payload = source._queue.enqueue.await_args_list[0].args[1]
    assert payload["url"] == "u1"
    assert isinstance(payload["tags"], list)  # Cubox tags 必须数组
    source._baseline.save_known.assert_called_once()


async def test_collect_skips_known(source):
    body = json.dumps({"data": [{"content": {"url": "u1", "title": "t1"}}], "paging": {"is_end": True}})
    source._scraper.fetch_via_page.return_value = {"status": 200, "body": body}
    source._session.acquire.return_value = {"cookies": []}
    source._baseline.get_known.return_value = {"u1"}  # 已知

    result = await source.collect()

    assert result.enqueued == {}
    assert result.skipped == 1
    source._queue.enqueue.assert_not_called()


async def test_collect_relogin_on_401(source):
    """scraper 401(LoginExpired) → mark_expired + 重试一次成功。"""
    body = json.dumps({"data": [{"content": {"url": "u1", "title": "t1"}}], "paging": {"is_end": True}})
    source._scraper.fetch_via_page.side_effect = [
        LoginExpired("401"),
        {"status": 200, "body": body},
    ]
    source._session.acquire.return_value = {"cookies": []}
    source._baseline.get_known.return_value = set()
    source._http.post.return_value.json.return_value = {
        "choices": [{"message": {"content": "x,y"}}]
    }

    result = await source.collect()

    assert result.enqueued == {"link": 1}
    source._session.mark_expired.assert_called_once_with("zhihu")
