"""文章归档应用编排分支测试。"""

from __future__ import annotations

from datetime import UTC, datetime

from inboxserver.domain.policy.article_archive import DefuddleArticle
from inboxserver.infrastructure.article_archive.service import ArticleArchiveService
from inboxserver.plugins.contracts import DispatchOutcome


class _Fetcher:
    def __init__(self, html: str = "direct", error: Exception | None = None):
        self.html = html
        self.error = error
        self.calls = 0

    async def fetch(self, url: str) -> str:
        self.calls += 1
        if self.error:
            raise self.error
        return self.html


class _Bridge:
    def __init__(self, articles: list[DefuddleArticle]):
        self.articles = list(articles)
        self.parsed: list[str] = []
        self.rendered = []

    async def parse(self, url: str, html: str) -> DefuddleArticle:
        self.parsed.append(html)
        return self.articles.pop(0)

    async def render(self, metadata: dict, markdown: str) -> str:
        self.rendered.append((metadata, markdown))
        return f"---\ntitle: {metadata['title']}\n---\n{markdown}\n"


class _BrowserFetch:
    def __init__(self, html: str = "rendered", error: Exception | None = None):
        self.html = html
        self.error = error
        self.calls = 0

    async def __call__(self, url: str) -> str:
        self.calls += 1
        if self.error:
            raise self.error
        return self.html


class _ArchiveRepository:
    def __init__(self, created: bool = True, error: Exception | None = None):
        self._created = created
        self.error = error
        self.saved: list[tuple[str, str, bytes]] = []

    async def save_if_absent(self, filename: str, source_url: str, content: bytes) -> bool:
        if self.error:
            raise self.error
        self.saved.append((filename, source_url, content))
        return self._created


def _service(fetcher, bridge, browser, repository) -> ArticleArchiveService:
    return ArticleArchiveService(
        fetcher=fetcher,
        bridge=bridge,
        browser_fetch=browser,
        repository=repository,
        min_visible_characters=20,
        clock=lambda: datetime(2026, 7, 16, 1, tzinfo=UTC),
    )


def _valid(title: str = "测试 文章") -> DefuddleArticle:
    return DefuddleArticle(
        title=title,
        author="作者",
        published_at="2026-07-15",
        markdown="有效正文" * 20 + "\n![图](https://img.example.com/a.jpg)",
    )


async def test_direct_valid_article_skips_browser_and_saves_markdown() -> None:
    fetcher = _Fetcher()
    bridge = _Bridge([_valid()])
    browser = _BrowserFetch()
    repository = _ArchiveRepository()
    service = _service(fetcher, bridge, browser, repository)

    ok, outcome = await service.process(
        {"url": "https://example.com/a", "title": "queue title", "tags": ["AI"]}
    )

    assert ok is True and outcome is DispatchOutcome.OK
    assert browser.calls == 0
    assert repository.saved[0][:2] == (
        "20260716-测试文章.md",
        "https://example.com/a",
    )
    assert "https://img.example.com/a.jpg" in repository.saved[0][2].decode()
    assert bridge.rendered[0][0]["tags"] == ["AI"]


async def test_short_direct_result_uses_playwright_then_uploads() -> None:
    bridge = _Bridge([DefuddleArticle(title="短", markdown="短"), _valid("完整文章")])
    browser = _BrowserFetch()
    repository = _ArchiveRepository()

    ok, outcome = await _service(_Fetcher(), bridge, browser, repository).process(
        {"url": "https://example.com/a", "tags": []}
    )

    assert ok is True and outcome is DispatchOutcome.OK
    assert bridge.parsed == ["direct", "rendered"]
    assert browser.calls == 1
    assert len(repository.saved) == 1


async def test_preexcluded_and_twice_invalid_pages_are_successful_skips() -> None:
    pre_fetcher = _Fetcher()
    pre_bridge = _Bridge([])
    pre_browser = _BrowserFetch()
    pre_repository = _ArchiveRepository()
    assert await _service(pre_fetcher, pre_bridge, pre_browser, pre_repository).process(
        {"url": "https://youtube.com/watch?v=1"}
    ) == (True, DispatchOutcome.OK)
    assert pre_fetcher.calls == 0 and pre_browser.calls == 0

    bridge = _Bridge(
        [
            DefuddleArticle(title="短", markdown="短"),
            DefuddleArticle(title="还是短", markdown="还是短"),
        ]
    )
    repository = _ArchiveRepository()
    assert await _service(_Fetcher(), bridge, _BrowserFetch(), repository).process(
        {"url": "https://example.com/navigation"}
    ) == (True, DispatchOutcome.OK)
    assert not repository.saved


async def test_existing_target_is_successful_skip_without_overwrite() -> None:
    repository = _ArchiveRepository(created=False)

    result = await _service(
        _Fetcher(), _Bridge([_valid()]), _BrowserFetch(), repository
    ).process({"url": "https://example.com/a", "tags": []})

    assert result == (True, DispatchOutcome.OK)
    assert len(repository.saved) == 1


async def test_recoverable_browser_or_git_failures_return_fail() -> None:
    short = DefuddleArticle(title="短", markdown="短")
    browser_failure = await _service(
        _Fetcher(),
        _Bridge([short]),
        _BrowserFetch(error=RuntimeError("timeout")),
        _ArchiveRepository(),
    ).process({"url": "https://example.com/a"})
    assert browser_failure == (False, DispatchOutcome.FAIL)

    git_failure = await _service(
        _Fetcher(),
        _Bridge([_valid()]),
        _BrowserFetch(),
        _ArchiveRepository(error=RuntimeError("temporary")),
    ).process({"url": "https://example.com/a"})
    assert git_failure == (False, DispatchOutcome.FAIL)
