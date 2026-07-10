"""滴答清单 source 测试：只处理含链接的收集箱任务。"""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

from inboxserver.domain.models import ItemKind
from inboxserver.plugins.sources.dida import DIDA_API, DidaSource


def _response(tasks: list[dict]) -> Mock:
    resp = Mock()
    resp.json.return_value = {"tasks": tasks}
    return resp


async def test_collect_keeps_plain_tasks_in_inbox():
    http = AsyncMock()
    queue = AsyncMock()
    state = AsyncMock()
    source = DidaSource({"access_token": "token"}, http, queue, state)
    state.get_saved_titles.return_value = set()
    http.get.return_value = _response(
        [
            {"id": "plain", "projectId": "p1", "title": "买牛奶", "content": ""},
            {
                "id": "link",
                "projectId": "p1",
                "title": "文章",
                "content": "https://example.com/a",
            },
        ]
    )

    result = await source.collect()

    assert result.enqueued == {"link": 1}
    http.delete.assert_awaited_once_with(
        f"{DIDA_API}/project/p1/task/link",
        headers={"Authorization": "Bearer token"},
    )
    queue.enqueue.assert_awaited_once_with(
        ItemKind.LINK,
        {"url": "https://example.com/a", "title": "文章", "tags": []},
    )
    state.save_saved_titles.assert_awaited_once_with("token", {"文章"})


async def test_collect_deletes_saved_link_without_reenqueue():
    http = AsyncMock()
    queue = AsyncMock()
    state = AsyncMock()
    source = DidaSource({"access_token": "token"}, http, queue, state)
    state.get_saved_titles.return_value = {"文章"}
    http.get.return_value = _response(
        [
            {
                "id": "link",
                "projectId": "p1",
                "title": "文章",
                "content": "https://example.com/a",
            }
        ]
    )

    result = await source.collect()

    assert result.enqueued == {"link": 0}
    http.delete.assert_awaited_once_with(
        f"{DIDA_API}/project/p1/task/link",
        headers={"Authorization": "Bearer token"},
    )
    queue.enqueue.assert_not_awaited()
    state.save_saved_titles.assert_not_awaited()
