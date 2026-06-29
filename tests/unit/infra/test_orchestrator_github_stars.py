"""API source 编排测试：github_stars 可经 run_collect 入队。"""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

from inboxserver.config.channels import ChannelEntry, ChannelsConfig
from inboxserver.domain.models import ItemKind
from inboxserver.infrastructure.collectors.orchestrator import run_collect
from inboxserver.infrastructure.queue.repository import RedisQueueRepository


def _response(data):
    resp = Mock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = data
    return resp


async def test_run_collect_invokes_github_stars(fake_redis, db_session):
    channels = ChannelsConfig(
        sources={
            "github_stars": ChannelEntry(
                enabled=True,
                config={"token": "ghp_test"},
            )
        }
    )
    http = AsyncMock()
    http.get.side_effect = [
        _response([{"html_url": "https://github.com/a/repo", "full_name": "a/repo"}]),
        _response([]),
    ]

    results = await run_collect(channels, http, fake_redis, db_session)

    assert results["github_stars"]["enqueued"] == {"link": 1}
    item = await RedisQueueRepository(fake_redis).dequeue(ItemKind.LINK)
    assert item == {"url": "https://github.com/a/repo", "title": "a/repo", "tags": []}
