"""Telegram 来源（API 源）：getUpdates long-polling → 链接/文本入队。

链接（含 md [title](url)）→ link 队列；纯文本 → text 队列；offset 持久化。
（来自 inbox_sync.poll_telegram）文件下载 MVP 暂不支持，后续补。
"""

from __future__ import annotations

import httpx

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.urls import extract_url_title_pairs
from inboxserver.infrastructure.persistence.repositories.telegram_offset import TelegramOffsetRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult, SourceKind

TELEGRAM_API = "https://api.telegram.org"


class TelegramSource:
    name = "telegram"
    kind = SourceKind.API
    required_config = ["bot_token"]

    def __init__(
        self,
        config: dict,
        http: httpx.AsyncClient,
        queue_repo: RedisQueueRepository,
        offset_repo: TelegramOffsetRepo,
    ):
        self._token = config["bot_token"]
        self._http = http
        self._queue = queue_repo
        self._offset = offset_repo

    async def collect(self) -> CollectResult:
        offset = await self._offset.get(self._token)
        try:
            resp = await self._http.get(
                f"{TELEGRAM_API}/bot{self._token}/getUpdates",
                params={
                    "offset": offset + 1,
                    "timeout": 10,  # long-polling：最多阻塞 10s 等新消息
                    "allowed_updates": '["message"]',
                },
            )
            data = resp.json()
        except Exception as e:
            return CollectResult(meta={"platform": "telegram", "error": repr(e)})

        enqueued: dict[str, int] = {}
        new_offset = offset
        for update in data.get("result", []):
            new_offset = max(new_offset, update.get("update_id", new_offset))
            msg = update.get("message", {})
            text = msg.get("text", "")
            pairs = extract_url_title_pairs(text)
            if pairs:
                for url, title in pairs:
                    await self._queue.enqueue(
                        ItemKind.LINK, {"url": url, "title": title, "tags": []}
                    )
                    enqueued["link"] = enqueued.get("link", 0) + 1
            elif text:
                await self._queue.enqueue(ItemKind.TEXT, {"content": text})
                enqueued["text"] = enqueued.get("text", 0) + 1
            # 文件（photo/document）：MVP 暂不支持，后续补 process_telegram_file
        if new_offset > offset:
            await self._offset.save(self._token, new_offset)
        return CollectResult(enqueued=enqueued, meta={"platform": "telegram"})
