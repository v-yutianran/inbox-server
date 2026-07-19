"""文章归档应用编排：双阶段抓取、正文验收、渲染和仓库交付。"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Protocol

import structlog

from inboxserver.domain.policy.article_archive import (
    DefuddleArticle,
    assess_article,
    build_archive_filename,
    normalize_archive_metadata,
    preexclude_reason,
    url_fingerprint,
)
from inboxserver.plugins.contracts import DispatchOutcome

log = structlog.get_logger(__name__)
_SAFE_ERROR_CODE = re.compile(r"^[a-z0-9_]{1,64}$")


class HtmlFetcher(Protocol):
    async def fetch(self, url: str) -> str: ...


class ArticleBridge(Protocol):
    async def parse(self, url: str, html: str) -> DefuddleArticle: ...

    async def render(self, metadata: dict, markdown: str) -> str: ...


class ArticleRepository(Protocol):
    async def save_if_absent(self, filename: str, source_url: str, content: bytes) -> bool: ...


class ArticleEventRecorder(Protocol):
    async def __call__(
        self,
        *,
        source_url: str,
        url_fingerprint: str,
        title: str,
        status: str,
        reason: str | None,
        filename: str | None,
    ) -> None: ...


class ArticleArchiveService:
    """协调文章归档 IO；所有永久性非文章结果映射为成功跳过。"""

    def __init__(
        self,
        *,
        fetcher: HtmlFetcher,
        bridge: ArticleBridge,
        browser_fetch: Callable[[str], Awaitable[str]],
        repository: ArticleRepository,
        event_recorder: ArticleEventRecorder | None = None,
        min_visible_characters: int,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._bridge = bridge
        self._browser_fetch = browser_fetch
        self._repository = repository
        self._event_recorder = event_recorder
        self._min_visible_characters = min_visible_characters
        self._clock = clock or (lambda: datetime.now(UTC))

    async def process(self, item: dict) -> tuple[bool, DispatchOutcome]:
        """处理单个归档任务，保持通用 consumer 的返回契约。"""
        url = str(item.get("url") or "")
        fp = url_fingerprint(url)
        excluded = preexclude_reason(url)
        if excluded:
            log.info("article_archive_skipped", url_fingerprint=fp, reason=excluded)
            await self._record_event(
                source_url=url,
                url_fingerprint=fp,
                title=str(item.get("title") or ""),
                status="skipped",
                reason=excluded,
                filename=None,
            )
            return True, DispatchOutcome.OK

        article = await self._try_direct(url, fp)
        if article is None:
            try:
                html = await self._browser_fetch(url)
                article = await self._bridge.parse(url, html)
            except Exception as error:
                log.warning(
                    "article_archive_browser_failed",
                    url_fingerprint=fp,
                    error_type=type(error).__name__,
                )
                await self._record_event(
                    source_url=url,
                    url_fingerprint=fp,
                    title=str(item.get("title") or ""),
                    status="failed",
                    reason=type(error).__name__,
                    filename=None,
                )
                return False, DispatchOutcome.FAIL
            assessment = assess_article(
                article,
                min_visible_characters=self._min_visible_characters,
            )
            if not assessment.valid:
                log.info(
                    "article_archive_skipped",
                    url_fingerprint=fp,
                    reason=assessment.reason,
                    visible_characters=assessment.visible_characters,
                )
                await self._record_event(
                    source_url=url,
                    url_fingerprint=fp,
                    title=article.title,
                    status="skipped",
                    reason=assessment.reason,
                    filename=None,
                )
                return True, DispatchOutcome.OK

        try:
            archived_at = self._clock()
            metadata = normalize_archive_metadata(
                title=article.title,
                source_url=url,
                archived_at=archived_at,
                author=article.author,
                published_at=article.published_at,
                tags=item.get("tags") if isinstance(item.get("tags"), list) else [],
            )
            markdown = await self._bridge.render(metadata, article.markdown)
            filename = build_archive_filename(url, article.title, archived_at)
            created = await self._repository.save_if_absent(
                filename,
                url,
                markdown.encode(),
            )
            log.info(
                "article_archive_committed" if created else "article_archive_exists",
                url_fingerprint=fp,
                filename=filename,
                bytes=len(markdown.encode()),
            )
            await self._record_event(
                source_url=url,
                url_fingerprint=fp,
                title=article.title,
                status="committed" if created else "exists",
                reason=None,
                filename=filename,
            )
            return True, DispatchOutcome.OK
        except Exception as error:
            error_code = str(error)
            log.warning(
                "article_archive_failed",
                url_fingerprint=fp,
                error_type=type(error).__name__,
                error_code=error_code if _SAFE_ERROR_CODE.fullmatch(error_code) else None,
            )
            await self._record_event(
                source_url=url,
                url_fingerprint=fp,
                title=article.title,
                status="failed",
                reason=(
                    error_code
                    if _SAFE_ERROR_CODE.fullmatch(error_code)
                    else type(error).__name__
                ),
                filename=None,
            )
            return False, DispatchOutcome.FAIL

    async def _record_event(
        self,
        *,
        source_url: str,
        url_fingerprint: str,
        title: str,
        status: str,
        reason: str | None,
        filename: str | None,
    ) -> None:
        if self._event_recorder is None:
            return
        try:
            await self._event_recorder(
                source_url=source_url,
                url_fingerprint=url_fingerprint,
                title=title,
                status=status,
                reason=reason,
                filename=filename,
            )
        except Exception as error:
            log.warning(
                "article_archive_event_record_failed",
                url_fingerprint=url_fingerprint,
                error_type=type(error).__name__,
            )

    async def _try_direct(self, url: str, fp: str) -> DefuddleArticle | None:
        try:
            article = await self._bridge.parse(url, await self._fetcher.fetch(url))
        except Exception as error:
            log.info(
                "article_archive_fallback",
                url_fingerprint=fp,
                reason=type(error).__name__,
            )
            return None
        assessment = assess_article(
            article,
            min_visible_characters=self._min_visible_characters,
        )
        if assessment.valid:
            return article
        log.info(
            "article_archive_fallback",
            url_fingerprint=fp,
            reason=assessment.reason,
            visible_characters=assessment.visible_characters,
        )
        return None
