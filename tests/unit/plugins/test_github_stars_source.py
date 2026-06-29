"""GitHub Star source 单测：解析 starred repos → 增量入队 link。"""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import httpx

from inboxserver.domain.models import ItemKind
from inboxserver.plugins.sources.github_stars import (
    SOURCE_NAME,
    GitHubStarsSource,
    parse_github_starred_repos,
)


def _response(data):
    resp = Mock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = data
    return resp


def test_parse_github_starred_repos():
    repos = parse_github_starred_repos(
        [
            {"html_url": "https://github.com/a/repo", "full_name": "a/repo"},
            {"repo": {"html_url": "https://github.com/b/repo", "full_name": "b/repo"}},
            {"full_name": "missing/url"},
        ]
    )

    assert [repo.url for repo in repos] == [
        "https://github.com/a/repo",
        "https://github.com/b/repo",
    ]
    assert repos[0].title == "a/repo"


async def test_collect_imports_history_and_saves_baseline():
    http = AsyncMock()
    queue = AsyncMock()
    baseline = AsyncMock()
    source = GitHubStarsSource(
        {"token": "ghp_test"},
        http,
        queue,
        baseline,
    )
    baseline.get_known.return_value = set()
    http.get.side_effect = [
        _response(
            [
                {"html_url": "https://github.com/a/repo", "full_name": "a/repo"},
                {"html_url": "https://github.com/b/repo", "full_name": "b/repo"},
            ]
        ),
        _response([]),
    ]

    result = await source.collect()

    assert result.enqueued == {"link": 2}
    assert http.get.await_args_list[0].kwargs["params"]["sort"] == "created"
    assert http.get.await_args_list[0].kwargs["params"]["direction"] == "desc"
    assert queue.enqueue.await_count == 2
    queue.enqueue.assert_any_await(
        ItemKind.LINK,
        {"url": "https://github.com/a/repo", "title": "a/repo", "tags": []},
    )
    baseline.save_known.assert_awaited_once_with(
        SOURCE_NAME,
        {"https://github.com/a/repo", "https://github.com/b/repo"},
    )


async def test_collect_only_enqueues_new_and_stops_on_known_page():
    http = AsyncMock()
    queue = AsyncMock()
    baseline = AsyncMock()
    source = GitHubStarsSource(
        {"token": "ghp_test"},
        http,
        queue,
        baseline,
    )
    baseline.get_known.return_value = {"https://github.com/old/repo"}
    http.get.side_effect = [
        _response(
            [
                {"html_url": "https://github.com/new/repo", "full_name": "new/repo"},
                {"html_url": "https://github.com/old/repo", "full_name": "old/repo"},
            ]
        ),
        _response(
            [
                {"html_url": "https://github.com/old/repo", "full_name": "old/repo"},
            ]
        ),
    ]

    result = await source.collect()

    assert result.enqueued == {"link": 1}
    assert http.get.await_count == 2
    queue.enqueue.assert_awaited_once_with(
        ItemKind.LINK,
        {"url": "https://github.com/new/repo", "title": "new/repo", "tags": []},
    )
    baseline.save_known.assert_awaited_once_with(
        SOURCE_NAME,
        {"https://github.com/old/repo", "https://github.com/new/repo"},
    )


async def test_collect_returns_error_meta_on_github_failure():
    http = AsyncMock()
    queue = AsyncMock()
    baseline = AsyncMock()
    source = GitHubStarsSource(
        {"token": "bad"},
        http,
        queue,
        baseline,
    )
    baseline.get_known.return_value = set()
    request = httpx.Request("GET", "https://api.github.com/user/starred")
    response = httpx.Response(401, request=request)
    github_response = _response([])
    github_response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "401",
        request=request,
        response=response,
    )
    http.get.return_value = github_response

    result = await source.collect()

    assert result.meta
    assert result.meta["platform"] == SOURCE_NAME
    assert "error" in result.meta
    queue.enqueue.assert_not_awaited()
    baseline.save_known.assert_not_awaited()
