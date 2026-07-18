"""文章归档配置测试：旧配置兼容，启用参数强类型校验。"""

from __future__ import annotations

import pytest

from inboxserver.config.channels import load_channels


def test_article_archive_defaults_to_disabled(tmp_path) -> None:
    config_path = tmp_path / "channels.yaml"
    config_path.write_text("sources: {}\ndestinations: {}\n")

    config = load_channels(config_path)

    assert config.article_archive.enabled is False
    assert config.article_archive.repository_dir == "/article-repository"
    assert config.article_archive.articles_dir == "references/article"
    assert config.article_archive.min_visible_characters == 200
    assert config.article_archive.daily_limit == 10_000


def test_article_archive_loads_typed_limits(tmp_path) -> None:
    config_path = tmp_path / "channels.yaml"
    config_path.write_text(
        """
article_archive:
  enabled: true
  repository_dir: /custom-agents
  articles_dir: references/custom-article
  min_visible_characters: 300
  http_timeout_seconds: 12
  browser_timeout_seconds: 34
  defuddle_timeout_seconds: 20
  max_html_bytes: 5000000
  max_output_bytes: 6000000
  enqueue_attempts: 2
  rate_window_count: 20
  rate_window_seconds: 3600
  daily_limit: 100
  interval_seconds: 1
"""
    )

    config = load_channels(config_path).article_archive

    assert config.enabled is True
    assert config.repository_dir == "/custom-agents"
    assert config.articles_dir == "references/custom-article"
    assert config.min_visible_characters == 300
    assert config.enqueue_attempts == 2
    assert config.daily_limit == 100


def test_article_archive_rejects_invalid_limits(tmp_path) -> None:
    config_path = tmp_path / "channels.yaml"
    config_path.write_text("article_archive:\n  enabled: true\n  max_html_bytes: 0\n")

    with pytest.raises(ValueError):
        load_channels(config_path)
