"""Telegram source 测试：链接 / 文本 / 文件（detect + download 入队 file）。"""

from __future__ import annotations

import httpx
import pytest
import respx

from inboxserver.domain.models import ItemKind
from inboxserver.infrastructure.persistence.repositories.telegram_offset import TelegramOffsetRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.sources.telegram import TelegramSource

TG = "https://api.telegram.org"


@pytest.fixture
async def tg(fake_redis, db_session, tmp_path):
    src = TelegramSource(
        {"bot_token": "T"},
        httpx.AsyncClient(),
        RedisQueueRepository(fake_redis),
        TelegramOffsetRepo(db_session),
        staging_dir=str(tmp_path),
    )
    yield src
    await src._http.aclose()


@respx.mock
async def test_collect_link(tg):
    respx.get(f"{TG}/botT/getUpdates").mock(
        return_value=httpx.Response(
            200, json={"result": [{"update_id": 1, "message": {"text": "https://x.com"}}]}
        )
    )
    assert (await tg.collect()).enqueued == {"link": 1}


@respx.mock
async def test_collect_plain_text(tg):
    respx.get(f"{TG}/botT/getUpdates").mock(
        return_value=httpx.Response(
            200, json={"result": [{"update_id": 1, "message": {"text": "hello world"}}]}
        )
    )
    assert (await tg.collect()).enqueued == {"text": 1}


@respx.mock
async def test_collect_document_file(tg, fake_redis):
    """文件消息 → getFile + 下载 → 入队 file（remote_name 用 file_name）。"""
    respx.get(f"{TG}/botT/getUpdates").mock(
        return_value=httpx.Response(
            200,
            json={
                "result": [
                    {
                        "update_id": 1,
                        "message": {
                            "document": {
                                "file_id": "f1",
                                "file_unique_id": "u1",
                                "file_name": "doc.pdf",
                            }
                        },
                    }
                ]
            },
        )
    )
    respx.get(f"{TG}/botT/getFile").mock(
        return_value=httpx.Response(200, json={"result": {"file_id": "f1", "file_path": "d/doc.pdf"}})
    )
    respx.get(f"{TG}/file/botT/d/doc.pdf").mock(return_value=httpx.Response(200, content=b"%PDF-1.4"))

    result = await tg.collect()
    assert result.enqueued == {"file": 1}
    item = await RedisQueueRepository(fake_redis).dequeue(ItemKind.FILE)
    assert item["remote_name"] == "doc.pdf"
    assert item["local_path"].endswith("doc.pdf")


@respx.mock
async def test_collect_photo_uses_largest(tg, fake_redis):
    """photo 是多尺寸数组 → 取最大（末尾）→ 后缀 .jpg。"""
    respx.get(f"{TG}/botT/getUpdates").mock(
        return_value=httpx.Response(
            200,
            json={
                "result": [
                    {
                        "update_id": 1,
                        "message": {
                            "photo": [
                                {"file_id": "small", "file_unique_id": "u"},
                                {"file_id": "big", "file_unique_id": "u"},
                            ]
                        },
                    }
                ]
            },
        )
    )
    respx.get(f"{TG}/botT/getFile").mock(
        return_value=httpx.Response(200, json={"result": {"file_id": "big", "file_path": "p.jpg"}})
    )
    respx.get(f"{TG}/file/botT/p.jpg").mock(return_value=httpx.Response(200, content=b"\xff\xd8\xff"))

    assert (await tg.collect()).enqueued == {"file": 1}
    item = await RedisQueueRepository(fake_redis).dequeue(ItemKind.FILE)
    assert item["remote_name"].endswith(".jpg")
