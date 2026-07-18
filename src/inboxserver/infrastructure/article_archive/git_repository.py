"""将文章 Markdown 原子写入本地 Git 仓库并完成提交推送。"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

from inboxserver.domain.policy.article_archive import url_fingerprint


class GitArticleRepository:
    """以 frontmatter 原始 URL 为幂等键交付文章，保留仓库其它工作区内容。"""

    def __init__(
        self,
        repository_dir: str | Path,
        *,
        articles_dir: str = "references/article",
        remote: str = "origin",
        branch: str = "main",
        github_token: str | None = None,
        askpass_path: str = "/app/scripts/github-askpass.sh",
        author_name: str = "Inbox Article Worker",
        author_email: str = "fishyer@users.noreply.github.com",
        git_timeout_seconds: float = 30,
        git_attempts: int = 3,
        git_retry_delay_seconds: float = 1,
    ) -> None:
        relative_articles = Path(articles_dir)
        if relative_articles.is_absolute() or ".." in relative_articles.parts:
            raise ValueError("article_repository_dir_must_be_relative")
        self._repository_dir = Path(repository_dir).resolve()
        self._articles_dir = self._repository_dir / relative_articles
        self._remote = remote
        self._branch = branch
        self._github_token = github_token
        self._askpass_path = askpass_path
        self._author_name = author_name
        self._author_email = author_email
        self._git_timeout_seconds = git_timeout_seconds
        self._git_attempts = git_attempts
        self._git_retry_delay_seconds = git_retry_delay_seconds
        self._lock = asyncio.Lock()

    async def save_if_absent(self, filename: str, source_url: str, content: bytes) -> bool:
        """保存并推送文章；返回本次是否创建了新文件。"""
        async with self._lock:
            return await asyncio.to_thread(
                self._save_if_absent,
                filename,
                source_url,
                content,
            )

    def _save_if_absent(self, filename: str, source_url: str, content: bytes) -> bool:
        if Path(filename).name != filename or not filename.endswith(".md"):
            raise ValueError("invalid_article_filename")
        remote_url = self._authenticated_remote_url(
            self._run_git("remote", "get-url", self._remote)
        )
        self._run_remote_git("pull", "--ff-only", remote_url, self._branch)
        self._articles_dir.mkdir(parents=True, exist_ok=True)

        article_path = self._find_by_source_url(source_url)
        created = article_path is None
        if article_path is None:
            article_path = self._collision_safe_path(filename, source_url)
            self._write_exclusive(article_path, content)

        relative_path = article_path.relative_to(self._repository_dir).as_posix()
        if self._run_git(
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            relative_path,
        ):
            self._run_git("add", "--", relative_path)
            self._run_git(
                "commit",
                "--only",
                "-m",
                f"docs(article): 归档《{article_path.stem}》",
                "--",
                relative_path,
            )
        self._run_remote_git("push", remote_url, f"HEAD:{self._branch}")
        return created

    def _authenticated_remote_url(self, remote_url: str) -> str:
        if not self._github_token:
            return remote_url
        if remote_url.startswith("git@github.com:"):
            return f"https://github.com/{remote_url.removeprefix('git@github.com:')}"
        prefix = "ssh://git@github.com/"
        if remote_url.startswith(prefix):
            return f"https://github.com/{remote_url.removeprefix(prefix)}"
        return remote_url

    def _find_by_source_url(self, source_url: str) -> Path | None:
        if not self._articles_dir.is_dir():
            return None
        for path in sorted(self._articles_dir.glob("*.md")):
            if self._read_source_url(path) == source_url:
                return path
        return None

    @staticmethod
    def _read_source_url(path: Path) -> str | None:
        try:
            with path.open(encoding="utf-8") as article:
                if article.readline().rstrip("\n") != "---":
                    return None
                for line in article:
                    if line.rstrip("\n") == "---":
                        return None
                    key, separator, value = line.partition(":")
                    if separator and key.strip() == "source_url":
                        parsed = json.loads(value.strip())
                        return parsed if isinstance(parsed, str) else None
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        return None

    def _collision_safe_path(self, filename: str, source_url: str) -> Path:
        target = self._articles_dir / filename
        if not target.exists():
            return target
        fingerprint = url_fingerprint(source_url)[:8]
        return target.with_name(f"{target.stem}-{fingerprint}{target.suffix}")

    @staticmethod
    def _write_exclusive(path: Path, content: bytes) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            dir=path.parent,
            prefix=".article-",
            suffix=".tmp",
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as temporary_file:
                temporary_file.write(content)
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _run_git(self, *args: str) -> str:
        action = args[0].replace("-", "_")
        git_config = ["-c", f"safe.directory={self._repository_dir}"]
        if self._github_token:
            git_config.extend(["-c", "http.proxy="])
        environment = {
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_NAME": self._author_name,
            "GIT_AUTHOR_EMAIL": self._author_email,
            "GIT_COMMITTER_NAME": self._author_name,
            "GIT_COMMITTER_EMAIL": self._author_email,
        }
        if self._github_token:
            environment.update(
                {
                    "GITHUB_TOKEN": self._github_token,
                    "GIT_ASKPASS": self._askpass_path,
                    "GIT_ASKPASS_REQUIRE": "force",
                }
            )
        try:
            result = subprocess.run(
                [
                    "git",
                    *git_config,
                    "-C",
                    str(self._repository_dir),
                    *args,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=self._git_timeout_seconds,
                env=environment,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(f"git_{action}_failed") from error
        if result.returncode != 0:
            raise RuntimeError(f"git_{action}_failed")
        return result.stdout.strip()

    def _run_remote_git(self, *args: str) -> str:
        for attempt in range(1, self._git_attempts + 1):
            try:
                return self._run_git(*args)
            except RuntimeError:
                if attempt == self._git_attempts:
                    raise
                time.sleep(self._git_retry_delay_seconds * attempt)
        raise RuntimeError("git_remote_failed")
