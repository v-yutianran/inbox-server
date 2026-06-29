"""GitHub Star 来源（API 源）：当前账号 starred repos → link 入队。

使用 GitHub REST API，按 Star 时间倒序分页；baseline 为空时导入历史全部 Star，
后续遇到整页已知即可停止。
"""

from __future__ import annotations

from typing import Any

import httpx

from inboxserver.domain.models import Bookmark, ItemKind
from inboxserver.infrastructure.persistence.repositories.baseline import IncrementalBaselineRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult, SourceKind

GITHUB_API = "https://api.github.com"
SOURCE_NAME = "github_stars"
PER_PAGE = 100
MAX_PAGES = 1000


def parse_github_starred_repos(items: list[dict[str, Any]]) -> list[Bookmark]:
    """解析 GitHub starred repos 响应，跳过缺少 html_url 的仓库。"""
    repos: list[Bookmark] = []
    for item in items:
        repo_payload = item.get("repo")
        repo: dict[str, Any] = repo_payload if isinstance(repo_payload, dict) else item
        url = repo.get("html_url")
        if not url:
            continue
        title = repo.get("full_name") or repo.get("name") or url
        repos.append(Bookmark(url=url, title=title))
    return repos


class GitHubStarsSource:
    name = SOURCE_NAME
    kind = SourceKind.API
    required_config = ["token"]

    def __init__(
        self,
        config: dict,
        http: httpx.AsyncClient,
        queue_repo: RedisQueueRepository,
        baseline_repo: IncrementalBaselineRepo,
    ):
        self._token = config["token"]
        self._http = http
        self._queue = queue_repo
        self._baseline = baseline_repo

    async def collect(self) -> CollectResult:
        """分页读取当前账号 Star 仓库，未见过的仓库入 link 队列。"""
        try:
            known = await self._baseline.get_known(SOURCE_NAME)
            seen: set[str] = set()
            all_new: list[Bookmark] = []
            skipped = 0
            for page in range(1, MAX_PAGES + 1):
                repos = await self._fetch_page(page)
                if not repos:
                    break
                page_urls = {repo.url for repo in repos}
                new = [repo for repo in repos if repo.url not in known and repo.url not in seen]
                skipped += len(repos) - len(new)
                all_new.extend(new)
                seen.update(page_urls)
                if page_urls and page_urls <= known:
                    break

            link_count = 0
            for repo in all_new:
                await self._queue.enqueue(
                    ItemKind.LINK, {"url": repo.url, "title": repo.title, "tags": []}
                )
                link_count += 1

            if all_new:
                await self._baseline.save_known(SOURCE_NAME, known | {repo.url for repo in all_new})
            return CollectResult(
                enqueued={"link": link_count} if link_count else {},
                skipped=skipped,
                meta={"platform": SOURCE_NAME, "new": link_count},
            )
        except Exception as e:
            return CollectResult(meta={"platform": SOURCE_NAME, "error": repr(e)})

    async def _fetch_page(self, page: int) -> list[Bookmark]:
        """读取一页 starred repos；非列表响应视为异常，避免静默误判为空。"""
        resp = await self._http.get(
            f"{GITHUB_API}/user/starred",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self._token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            params={
                "sort": "created",
                "direction": "desc",
                "per_page": PER_PAGE,
                "page": page,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list):
            raise ValueError("unexpected GitHub starred response")
        return parse_github_starred_repos(data)
