"""知乎文章 API 抓取适配器测试。"""

import asyncio
from unittest.mock import AsyncMock

import pytest
from lxml import html as lxml_html

from inboxserver.infrastructure.article_archive.zhihu_fetcher import (
    ZhihuArticleFetcher,
    ZhihuArticleFetchError,
)
from inboxserver.infrastructure.browser.scraper import LoginExpired


async def test_fetch_answer_content_through_authenticated_api() -> None:
    session = AsyncMock()
    session.acquire.return_value = {"cookies": [{"name": "z_c0"}]}
    scraper = AsyncMock()
    scraper.fetch_via_page.return_value = {
        "status": 200,
        "body": (
            '{"content":"<p>知乎回答正文</p>",'
            '"question":{"title":"知乎问题标题"}}'
        ),
    }
    fetcher = ZhihuArticleFetcher(
        session_manager=session,
        scrapers={"zhihu": scraper},
        credential_name="zhihu_creds",
    )

    html = await fetcher.fetch("https://www.zhihu.com/question/1/answer/2")

    document = lxml_html.fromstring(html)
    assert document.findtext("head/title") == "知乎问题标题"
    assert document.find("body/article").text_content() == "知乎回答正文"
    session.acquire.assert_awaited_once_with("zhihu", "zhihu_creds")
    scraper.fetch_via_page.assert_awaited_once_with(
        "zhihu",
        {"cookies": [{"name": "z_c0"}]},
        "/api/v4/answers/2?include=content,excerpt,question,author,created_time",
    )


@pytest.mark.parametrize(
    ("url", "scraper_name", "platform", "api_path", "body"),
    [
        (
            "https://zhuanlan.zhihu.com/p/672492578",
            "zhihu_article",
            "zhihu",
            "/api/articles/672492578",
            '{"content":"<p>知乎专栏正文</p>"}',
        ),
        (
            "https://www.zhihu.com/video/immersion/feed/2060315066403230701"
            "?object_type=pin&scene=",
            "zhihu",
            "zhihu",
            "/api/v4/pins/2060315066403230701",
            '{"content_html":"<p>知乎想法正文</p>"}',
        ),
    ],
)
async def test_fetches_supported_zhihu_article_urls(
    url: str, scraper_name: str, platform: str, api_path: str, body: str
) -> None:
    session = AsyncMock()
    session.acquire.return_value = {"cookies": []}
    scraper = AsyncMock()
    scraper.fetch_via_page.return_value = {"status": 200, "body": body}
    fetcher = ZhihuArticleFetcher(
        session_manager=session,
        scrapers={scraper_name: scraper},
        credential_name="zhihu_creds",
    )

    html = await fetcher.fetch(url)

    assert lxml_html.fromstring(html).find("body/article").text_content().startswith(
        "知乎"
    )
    scraper.fetch_via_page.assert_awaited_once_with(
        platform, {"cookies": []}, api_path
    )


async def test_api_rejection_is_retriable_instead_of_returning_error_page() -> None:
    session = AsyncMock()
    session.acquire.return_value = {"cookies": []}
    scraper = AsyncMock()
    scraper.fetch_via_page.return_value = {
        "status": 403,
        "body": '{"error":{"message":"当前请求存在异常"}}',
    }
    fetcher = ZhihuArticleFetcher(
        session_manager=session,
        scrapers={"zhihu": scraper},
        credential_name="zhihu_creds",
    )

    with pytest.raises(ZhihuArticleFetchError, match="zhihu_api_rejected"):
        await fetcher.fetch("https://www.zhihu.com/question/1/answer/2")


async def test_hanging_api_request_times_out() -> None:
    async def hang(*_args) -> dict:
        await asyncio.Event().wait()
        return {}

    session = AsyncMock()
    session.acquire.return_value = {"cookies": []}
    scraper = AsyncMock()
    scraper.fetch_via_page.side_effect = hang
    fetcher = ZhihuArticleFetcher(
        session_manager=session,
        scrapers={"zhihu": scraper},
        credential_name="zhihu_creds",
        timeout_seconds=0.01,
    )

    with pytest.raises(TimeoutError):
        await fetcher.fetch("https://www.zhihu.com/question/1/answer/2")


async def test_expired_login_is_refreshed_once() -> None:
    session = AsyncMock()
    session.acquire.side_effect = [{"state": 1}, {"state": 2}]
    scraper = AsyncMock()
    scraper.fetch_via_page.side_effect = [
        LoginExpired("401"),
        {"status": 200, "body": '{"content":"<p>正文</p>"}'},
    ]
    fetcher = ZhihuArticleFetcher(
        session_manager=session,
        scrapers={"zhihu": scraper},
        credential_name="zhihu_creds",
    )

    html = await fetcher.fetch("https://www.zhihu.com/question/1/answer/2")
    assert lxml_html.fromstring(html).find("body/article").text_content() == "正文"
    session.mark_expired.assert_awaited_once_with("zhihu")
    assert session.acquire.await_count == 2
