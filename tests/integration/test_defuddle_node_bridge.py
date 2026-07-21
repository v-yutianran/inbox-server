"""真实 Node.js + Defuddle + Eta 桥接器集成测试，使用本地固定 HTML。"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock

import yaml

from inboxserver.domain.policy.article_archive import (
    assess_article,
    normalize_archive_metadata,
)
from inboxserver.infrastructure.article_archive.defuddle import DefuddleBridge
from inboxserver.infrastructure.article_archive.zhihu_fetcher import ZhihuArticleFetcher

ROOT = Path(__file__).parents[2]


async def test_node_bridge_parses_html_and_renders_obsidian_markdown() -> None:
    bridge = DefuddleBridge(script_path=ROOT / "scripts/article-archive.mjs")
    html = (ROOT / "tests/fixtures/article.html").read_text()

    article = await bridge.parse("https://example.com/article", html)
    metadata = normalize_archive_metadata(
        title='带"引号"的固定样本文章',
        source_url="https://example.com/article",
        archived_at=datetime(2026, 7, 16, tzinfo=UTC),
        author=article.author,
        published_at=article.published_at,
        tags=["AI", '带"引号"'],
    )
    markdown = await bridge.render(metadata, article.markdown)

    assert article.title == "固定样本文章"
    assert "用于验证 Defuddle" in article.markdown
    assert "https://img.example.com/remote.jpg" in article.markdown
    assert markdown.startswith("---\n")
    frontmatter, body = markdown.removeprefix("---\n").split("\n---\n", maxsplit=1)
    properties = yaml.safe_load(frontmatter)
    assert properties == {
        "title": '带"引号"的固定样本文章',
        "source_url": "https://example.com/article",
        "archived_at": "2026-07-16T08:00:00+08:00",
        "author": "测试作者",
        "published_at": "2026-07-15T08:00:00+08:00",
        "tags": ["AI", '带"引号"'],
    }
    assert 'tags: ["AI","带\\"引号\\""]' in markdown
    assert body.startswith("\n这是用于验证 Defuddle")
    assert markdown.endswith("\n")


async def test_node_bridge_handles_local_weixin_full_and_error_samples() -> None:
    bridge = DefuddleBridge(script_path=ROOT / "scripts/article-archive.mjs")
    full = await bridge.parse(
        "https://mp.weixin.qq.com/s/full",
        (ROOT / "tests/fixtures/weixin_article.html").read_text(),
    )
    error = await bridge.parse(
        "https://mp.weixin.qq.com/s/error",
        (ROOT / "tests/fixtures/weixin_error.html").read_text(),
    )

    assert full.title == "本地微信完整页"
    assert assess_article(full, min_visible_characters=200).valid is True
    assert "https://mmbiz.qpic.cn/example/remote.jpg" in full.markdown
    assert assess_article(error, min_visible_characters=200).reason in {
        "error_marker",
        "short_content",
    }


async def test_zhihu_api_document_is_parseable_by_real_defuddle() -> None:
    session = AsyncMock()
    session.acquire.return_value = {"cookies": []}
    scraper = AsyncMock()
    scraper.fetch_via_page.return_value = {
        "status": 200,
        "body": (
            '{"question":{"title":"知乎问题标题"},'
            '"content":"<p>这是知乎回答正文。</p><p>第二段正文。</p>"}'
        ),
    }
    fetcher = ZhihuArticleFetcher(
        session_manager=session,
        scrapers={"zhihu": scraper},
        credential_name="zhihu_creds",
    )
    bridge = DefuddleBridge(script_path=ROOT / "scripts/article-archive.mjs")

    html = await fetcher.fetch("https://www.zhihu.com/question/1/answer/2")
    article = await bridge.parse("https://www.zhihu.com/question/1/answer/2", html)

    assert article.title == "知乎问题标题"
    assert "这是知乎回答正文" in article.markdown
