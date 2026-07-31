"""通过知乎登录态 API 获取可交给 Defuddle 的文章 HTML。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlparse

from lxml import etree
from lxml import html as lxml_html

from inboxserver.infrastructure.browser.scraper import LoginExpired


class _SessionManager(Protocol):
    async def acquire(self, platform: str, credential_name: str) -> dict: ...

    async def mark_expired(self, platform: str, error: str = "401") -> None: ...


class _Scraper(Protocol):
    async def fetch_via_page(
        self, platform: str, storage_state: dict, path_or_url: str
    ) -> dict: ...


class ZhihuArticleFetchError(RuntimeError):
    """知乎文章 API 无法返回正文。"""


@dataclass(frozen=True)
class _ArticleRequest:
    scraper_name: str
    platform: str
    api_path: str
    content_field: str
    title_field: str


def _resolve_request(url: str) -> _ArticleRequest:
    parsed = urlparse(url)
    segments = [segment for segment in parsed.path.split("/") if segment]
    if (
        parsed.hostname == "www.zhihu.com"
        and len(segments) >= 4
        and segments[0] == "question"
        and segments[2] == "answer"
    ):
        return _ArticleRequest(
            scraper_name="zhihu",
            platform="zhihu",
            api_path=(
                f"/api/v4/answers/{segments[3]}"
                "?include=content,excerpt,question,author,created_time"
            ),
            content_field="content",
            title_field="question",
        )
    if (
        parsed.hostname == "zhuanlan.zhihu.com"
        and len(segments) >= 2
        and segments[0] == "p"
    ):
        return _ArticleRequest(
            scraper_name="zhihu_article",
            platform="zhihu",
            api_path=f"/api/articles/{segments[1]}",
            content_field="content",
            title_field="title",
        )
    if (
        parsed.hostname == "www.zhihu.com"
        and len(segments) >= 4
        and segments[:3] == ["video", "immersion", "feed"]
    ):
        return _ArticleRequest(
            scraper_name="zhihu",
            platform="zhihu",
            api_path=f"/api/v4/pins/{segments[3]}",
            content_field="content_html",
            title_field="excerpt_title",
        )
    if (
        parsed.hostname == "www.zhihu.com"
        and len(segments) >= 2
        and segments[0] == "pin"
    ):
        return _ArticleRequest(
            scraper_name="zhihu",
            platform="zhihu",
            api_path=f"/api/v4/pins/{segments[1]}",
            content_field="content_html",
            title_field="excerpt_title",
        )
    raise ValueError("unsupported_zhihu_article_url")


def _build_document(data: dict, request: _ArticleRequest) -> str:
    content = data.get(request.content_field)
    if not isinstance(content, str) or not content.strip():
        raise ZhihuArticleFetchError("zhihu_empty_content")
    if request.title_field == "question":
        question = data.get("question")
        title = question.get("title", "") if isinstance(question, dict) else ""
    else:
        title = data.get(request.title_field, "")
    title = str(title or "").partition(" | ")[0].strip()

    root = etree.Element("html")
    head = etree.SubElement(root, "head")
    etree.SubElement(head, "title").text = title
    article = etree.SubElement(etree.SubElement(root, "body"), "article")
    for fragment in lxml_html.fragments_fromstring(content):
        if isinstance(fragment, str):
            if len(article):
                article[-1].tail = (article[-1].tail or "") + fragment
            else:
                article.text = (article.text or "") + fragment
        else:
            article.append(fragment)
    return etree.tostring(root, encoding="unicode", method="html")


class ZhihuArticleFetcher:
    """把知乎页面 URL 映射到带登录态的内容 API。"""

    def __init__(
        self,
        *,
        session_manager: _SessionManager,
        scrapers: Mapping[str, _Scraper],
        credential_name: str,
        timeout_seconds: float = 90.0,
    ) -> None:
        self._session_manager = session_manager
        self._scrapers = scrapers
        self._credential_name = credential_name
        self._timeout_seconds = timeout_seconds

    async def _fetch_once(
        self, scraper: _Scraper, request: _ArticleRequest, storage_state: dict
    ) -> dict:
        async with asyncio.timeout(self._timeout_seconds):
            return await scraper.fetch_via_page(
                request.platform, storage_state, request.api_path
            )

    async def fetch(self, url: str) -> str:
        request = _resolve_request(url)
        storage_state = await self._session_manager.acquire(
            "zhihu", self._credential_name
        )
        scraper = self._scrapers[request.scraper_name]
        try:
            result = await self._fetch_once(scraper, request, storage_state)
        except LoginExpired:
            await self._session_manager.mark_expired("zhihu")
            storage_state = await self._session_manager.acquire(
                "zhihu", self._credential_name
            )
            result = await self._fetch_once(scraper, request, storage_state)
        if result.get("status") != 200:
            raise ZhihuArticleFetchError("zhihu_api_rejected")
        return _build_document(json.loads(result["body"]), request)
