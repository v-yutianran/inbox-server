"""历史文章 frontmatter 修复脚本集成测试。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[2]


def _run_repair(directory: Path, *, dry_run: bool) -> dict:
    command = [
        "node",
        str(ROOT / "scripts/repair-article-frontmatter.mjs"),
        "--directory",
        str(directory),
    ]
    if dry_run:
        command.append("--dry-run")
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def test_repair_script_dry_run_then_preserves_body_when_writing(tmp_path: Path) -> None:
    body = "\n# 正文\n\n包含 source_url: 字样但不能影响修复。\n"
    malformed = (
        "---\n"
        'title: "带\\\"引号\\\"的标题"'
        'source_url: "https://example.com/?a=1&b=2"'
        'archived_at: "2026-07-16T15:05:53+08:00"'
        'author: "作者"'
        'published_at: ""'
        'tags: ["AI编程工具","代码隔离"]'
        f"---\n{body}"
    )
    article = tmp_path / "article.md"
    article.write_text(malformed)

    dry_run = _run_repair(tmp_path, dry_run=True)
    assert dry_run == {
        "scanned": 1,
        "repairable": 1,
        "repaired": 0,
        "skipped": 0,
        "dry_run": True,
    }
    assert article.read_text() == malformed

    written = _run_repair(tmp_path, dry_run=False)
    assert written == {
        "scanned": 1,
        "repairable": 1,
        "repaired": 1,
        "skipped": 0,
        "dry_run": False,
    }
    repaired = article.read_text()
    frontmatter, repaired_body = repaired.removeprefix("---\n").split(
        "\n---\n", maxsplit=1
    )
    assert yaml.safe_load(frontmatter) == {
        "title": '带"引号"的标题',
        "source_url": "https://example.com/?a=1&b=2",
        "archived_at": "2026-07-16T15:05:53+08:00",
        "author": "作者",
        "published_at": "",
        "tags": ["AI编程工具", "代码隔离"],
    }
    assert repaired_body == body
