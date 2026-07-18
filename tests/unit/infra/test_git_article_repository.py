"""本地 Git 文章归档适配器的公共行为测试。"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path

import pytest

from inboxserver.infrastructure.article_archive.git_repository import GitArticleRepository


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-c", "core.quotePath=false", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _repository(tmp_path: Path) -> tuple[Path, Path, GitArticleRepository]:
    remote = tmp_path / "remote.git"
    worktree = tmp_path / "agents"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(worktree)],
        check=True,
        capture_output=True,
    )
    _git(worktree, "config", "user.name", "Article Worker")
    _git(worktree, "config", "user.email", "article@example.com")
    (worktree / "AGENTS.md").write_text("# Agents\n")
    _git(worktree, "add", "AGENTS.md")
    _git(worktree, "commit", "-m", "chore: initialize")
    _git(worktree, "remote", "add", "origin", str(remote))
    _git(worktree, "push", "-u", "origin", "main")
    return remote, worktree, GitArticleRepository(worktree)


def _markdown(source_url: str, title: str = "测试文章") -> bytes:
    return (
        "---\n"
        f'title: "{title}"\n'
        f'source_url: "{source_url}"\n'
        'archived_at: "2026-07-19T01:00:00+08:00"\n'
        'author: "作者"\n'
        'published_at: "2026-07-18"\n'
        "tags: []\n"
        "---\n"
        "正文\n"
    ).encode()


async def test_saves_commits_and_pushes_new_article(tmp_path: Path) -> None:
    remote, worktree, repository = _repository(tmp_path)

    created = await repository.save_if_absent(
        "20260719-测试文章.md",
        "https://example.com/a",
        _markdown("https://example.com/a"),
    )

    assert created is True
    article = worktree / "references/article/20260719-测试文章.md"
    assert article.is_file()
    assert _git(worktree, "status", "--short") == ""
    assert "references/article/20260719-测试文章.md" in _git(
        remote, "ls-tree", "-r", "--name-only", "main"
    )


async def test_exact_source_url_deduplicates_and_name_collision_gets_fingerprint(
    tmp_path: Path,
) -> None:
    _, worktree, repository = _repository(tmp_path)
    filename = "20260719-测试文章.md"
    first_url = "https://example.com/a?from=original"
    second_url = "https://example.com/b"

    assert await repository.save_if_absent(filename, first_url, _markdown(first_url)) is True
    assert await repository.save_if_absent(
        "20260720-另一个标题.md", first_url, _markdown(first_url)
    ) is False
    assert await repository.save_if_absent(filename, second_url, _markdown(second_url)) is True

    files = sorted((worktree / "references/article").glob("*.md"))
    assert len(files) == 2
    names = {path.name for path in files}
    assert filename in names
    assert any(path.stem.startswith("20260719-测试文章-") for path in files)
    assert _git(worktree, "rev-list", "--count", "HEAD") == "3"


async def test_retry_finishes_uncommitted_or_unpushed_article_without_duplicate(
    tmp_path: Path,
) -> None:
    remote, worktree, repository = _repository(tmp_path)
    article = worktree / "references/article/20260719-测试文章.md"
    article.parent.mkdir(parents=True)
    article.write_bytes(_markdown("https://example.com/retry"))

    assert await repository.save_if_absent(
        article.name,
        "https://example.com/retry",
        article.read_bytes(),
    ) is False
    assert _git(worktree, "status", "--short") == ""
    assert _git(remote, "rev-list", "--count", "main") == "2"

    second = worktree / "references/article/20260719-本地提交.md"
    second.write_bytes(_markdown("https://example.com/local-commit"))
    _git(worktree, "add", str(second.relative_to(worktree)))
    _git(worktree, "commit", "-m", "docs(article): 本地待推送")

    assert await repository.save_if_absent(
        second.name,
        "https://example.com/local-commit",
        second.read_bytes(),
    ) is False
    assert _git(remote, "rev-list", "--count", "main") == "3"


async def test_commits_only_article_and_reports_git_failure(tmp_path: Path) -> None:
    _, worktree, repository = _repository(tmp_path)
    (worktree / "AGENTS.md").write_text("用户未提交修改\n")
    (worktree / "private.txt").write_text("用户未跟踪文件\n")
    _git(worktree, "add", "AGENTS.md")

    assert await repository.save_if_absent(
        "20260719-测试文章.md",
        "https://example.com/a",
        _markdown("https://example.com/a"),
    ) is True
    assert _git(worktree, "diff", "--cached", "--name-only") == "AGENTS.md"
    assert (worktree / "private.txt").is_file()
    assert _git(worktree, "show", "--format=", "--name-only", "HEAD") == (
        "references/article/20260719-测试文章.md"
    )

    _git(worktree, "remote", "set-url", "origin", str(tmp_path / "missing.git"))
    with pytest.raises(RuntimeError, match="git_pull_failed"):
        await repository.save_if_absent(
            "20260719-失败.md",
            "https://example.com/failure",
            _markdown("https://example.com/failure"),
        )


async def test_transient_remote_failure_retries_without_refetching_article(tmp_path: Path) -> None:
    remote, worktree, _ = _repository(tmp_path)
    future_remote = tmp_path / "future-remote.git"
    _git(worktree, "remote", "set-url", "origin", str(future_remote))
    repository = GitArticleRepository(
        worktree,
        git_retry_delay_seconds=0.05,
    )

    delivery = asyncio.create_task(
        repository.save_if_absent(
            "20260719-网络重试.md",
            "https://example.com/transient",
            _markdown("https://example.com/transient"),
        )
    )
    await asyncio.sleep(0.02)
    remote.rename(future_remote)

    assert await delivery is True
    assert "references/article/20260719-网络重试.md" in _git(
        future_remote, "ls-tree", "-r", "--name-only", "main"
    )


async def test_commit_uses_worker_identity_without_host_git_config(tmp_path: Path) -> None:
    _, worktree, _ = _repository(tmp_path)
    _git(worktree, "config", "--unset", "user.name")
    _git(worktree, "config", "--unset", "user.email")
    repository = GitArticleRepository(
        worktree,
        author_name="Inbox Article Worker",
        author_email="worker@example.com",
    )

    assert await repository.save_if_absent(
        "20260719-容器身份.md",
        "https://example.com/container-identity",
        _markdown("https://example.com/container-identity"),
    )
    assert _git(worktree, "log", "-1", "--format=%an <%ae>") == (
        "Inbox Article Worker <worker@example.com>"
    )
