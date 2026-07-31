"""文章归档领域规则测试：仅验证纯函数，不触发网络或文件 IO。"""

from __future__ import annotations

from datetime import UTC, datetime

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.article_archive import (
    DefuddleArticle,
    archive_date,
    assess_article,
    build_archive_filename,
    normalize_archive_metadata,
    preexclude_reason,
)
from inboxserver.domain.policy.dedup import fingerprint


def test_article_kind_uses_stable_url_fingerprint() -> None:
    item = {"url": "https://example.com/article", "archived_at": "different"}

    assert ItemKind.ARTICLE.value == "article"
    assert fingerprint(item, ItemKind.ARTICLE) == fingerprint(item, ItemKind.ARTICLE)
    assert len(fingerprint(item, ItemKind.ARTICLE)) == 64


def test_preexclude_known_non_article_urls() -> None:
    assert preexclude_reason("ftp://example.com/a") == "unsupported_scheme"
    assert preexclude_reason("https://github.com/acme/repo") == "excluded_host"
    assert preexclude_reason("https://youtube.com/watch?v=1") == "excluded_host"
    assert preexclude_reason("https://example.com/report.pdf") == "download_file"
    assert preexclude_reason("https://mp.weixin.qq.com/s/abc") is None


def test_assess_article_rejects_error_missing_title_and_short_body() -> None:
    error = DefuddleArticle(title="错误页", markdown="请完成验证" * 100)
    zhihu_restricted = DefuddleArticle(
        title="",
        markdown='{"error":{"message":"您当前请求存在异常，暂时限制本次访问。"}}',
    )
    missing_title = DefuddleArticle(title="", markdown="有效正文" * 100)
    short = DefuddleArticle(title="短文", markdown="[链接](https://example.com) 很短")

    assert assess_article(error, min_visible_characters=20).reason == "error_marker"
    assert assess_article(zhihu_restricted, min_visible_characters=20).reason == "error_marker"
    assert assess_article(missing_title, min_visible_characters=20).reason == "missing_title"
    assert assess_article(short, min_visible_characters=20).reason == "short_content"


def test_assess_article_accepts_visible_content_and_preserves_remote_images() -> None:
    article = DefuddleArticle(
        title="正文",
        markdown="![图](https://img.example.com/a.jpg)\n" + "有效正文" * 60,
    )

    assessment = assess_article(article, min_visible_characters=200)

    assert assessment.valid is True
    assert "https://img.example.com/a.jpg" in article.markdown


def test_archive_filename_uses_shanghai_date_and_removes_whitespace_and_specials() -> None:
    moment = datetime(2026, 7, 15, 16, 30, tzinfo=UTC)

    assert archive_date(moment) == "20260716"
    assert build_archive_filename(
        "https://mp.weixin.qq.com/s/abc",
        " AI / Agent：实践 * 指南？ ",
        moment,
    ) == "20260716-AIAgent实践指南.md"


def test_archive_filename_has_deterministic_fallback_and_length_limit() -> None:
    moment = datetime(2026, 7, 16, 1, tzinfo=UTC)
    first = build_archive_filename("https://example.com/a", " !!! ", moment)
    second = build_archive_filename("https://example.com/a", " ### ", moment)

    assert first == second
    assert first.startswith("20260716-examplecom-")
    assert first.endswith(".md")
    assert " " not in first
    assert len(
        build_archive_filename("https://example.com/a", "很长" * 200, moment)
    ) <= 120


def test_normalize_archive_metadata_keeps_stable_frontmatter_fields() -> None:
    metadata = normalize_archive_metadata(
        title='带"引号"的标题',
        source_url="https://example.com/a",
        archived_at=datetime(2026, 7, 16, 8, tzinfo=UTC),
        author=None,
        published_at=None,
        tags=[" AI ", "效率", "AI", ""],
    )

    assert metadata == {
        "title": '带"引号"的标题',
        "source_url": "https://example.com/a",
        "archived_at": "2026-07-16T16:00:00+08:00",
        "author": "",
        "published_at": "",
        "tags": ["AI", "效率"],
    }
