"""sync pipeline e2e：telegram source → 入队 → worker consume → cubox destination。

端到端验证核心闭环：真实 source.collect（respx mock getUpdates）→ enqueue →
真实 consume 循环 → 真实 cubox.dispatch（respx mock）→ mark_done。
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
import respx

from inboxserver.domain.models import ItemKind
from inboxserver.infrastructure.persistence.repositories.telegram_offset import TelegramOffsetRepo
from inboxserver.infrastructure.queue.dedup_store import DedupStore
from inboxserver.infrastructure.queue.rate_guard import RateGuard
from inboxserver.infrastructure.queue.repository import RedisQueueRepository, queue_key
from inboxserver.plugins.destinations.cubox import CuboxDestination
from inboxserver.plugins.sources.telegram import TelegramSource
from inboxserver.workers.consumer import consume

_LIMITS = dict(window_count=120, window_sec=21600, daily_limit=480, interval=0.01)
TG_URL = "https://api.telegram.org/botT/getUpdates"
CUBOX_URL = "https://cubox.test/api"


@respx.mock
async def test_pipeline_telegram_to_cubox(fake_redis, db_session):
    queue_repo = RedisQueueRepository(fake_redis)
    dedup = DedupStore(fake_redis)
    rate = RateGuard(fake_redis)
    http = httpx.AsyncClient()

    # 1. telegram source 入队 1 条链接
    respx.get(TG_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "result": [
                    {"update_id": 100, "message": {"text": "https://example.com/p"}}
                ]
            },
        )
    )
    tg = TelegramSource({"bot_token": "T"}, http, queue_repo, TelegramOffsetRepo(db_session))
    result = await tg.collect()
    assert result.enqueued == {"link": 1}
    assert await queue_repo.len(ItemKind.LINK) == 1

    # 2. worker consume → cubox（mock code=200 → OK）
    cubox_route = respx.post(CUBOX_URL).mock(return_value=httpx.Response(200, json={"code": 200}))
    cubox = CuboxDestination({"api_url": CUBOX_URL}, http)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            consume(ItemKind.LINK, queue_repo, dedup, rate, cubox.dispatch, "link", **_LIMITS),
            timeout=1.0,
        )

    # 3. 断言：cubox 收到、queue 空、mark_done
    assert cubox_route.called
    assert await queue_repo.len(ItemKind.LINK) == 0
    assert await dedup.is_done(queue_key(ItemKind.LINK), "https://example.com/p")
    await http.aclose()
