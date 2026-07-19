"""文章归档终态事件 Repository 行为测试。"""

from __future__ import annotations

from inboxserver.infrastructure.persistence.repositories.article_archive_event import (
    ArticleArchiveEventRepo,
)


async def test_article_archive_event_is_persisted_and_queryable(db_session):
    repo = ArticleArchiveEventRepo(db_session)
    await repo.record(
        source_url="https://example.com/article",
        url_fingerprint="0123456789",
        title="示例文章",
        status="committed",
        reason=None,
        filename="20260719-示例文章.md",
    )

    events = await repo.list_recent(limit=10)
    assert len(events) == 1
    assert events[0].source_url == "https://example.com/article"
    assert events[0].url_fingerprint == "0123456789"
    assert events[0].status == "committed"
    assert events[0].filename == "20260719-示例文章.md"
    assert events[0].occurred_at is not None
