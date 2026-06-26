"""Telegram 来源（API 源）：getUpdates long-polling → 链接/文本/文件入队。

链接（含 md）→ link；纯文本 → text；文件（photo/document/video/voice/audio/animation）
→ getFile + 下载到暂存 → file 队列。offset 持久化。
（来自 inbox_sync.poll_telegram + process_telegram_file）

跨容器注意：server 下载、worker 消费在不同容器，staging_dir 需共享 volume（docker-compose 侧）。
"""

from __future__ import annotations

import os
import os.path

import httpx

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.urls import extract_url_title_pairs
from inboxserver.infrastructure.persistence.repositories.telegram_offset import TelegramOffsetRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult, SourceKind

TELEGRAM_API = "https://api.telegram.org"

# Telegram msg 字段 → 文件类型归类
_FILE_TYPE_MAP = {
    "photo": "photo",
    "document": "document",
    "video": "video",
    "animation": "video",
    "voice": "audio",
    "audio": "audio",
}
# 无 file_name 时的默认后缀
_DEFAULT_EXT = {"photo": ".jpg", "video": ".mp4", "audio": ".mp3", "document": ""}


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
        staging_dir: str = "/tmp/inbox-files",
    ):
        self._token = config["bot_token"]
        self._http = http
        self._queue = queue_repo
        self._offset = offset_repo
        self._staging = staging_dir
        os.makedirs(self._staging, exist_ok=True)

    async def collect(self) -> CollectResult:
        offset = await self._offset.get(self._token)
        try:
            resp = await self._http.get(
                f"{TELEGRAM_API}/bot{self._token}/getUpdates",
                params={
                    "offset": offset + 1,
                    "timeout": 10,  # long-polling
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
            # 文件优先（photo/document/video/voice/audio/animation）
            file_info = self._detect_file(msg)
            if file_info:
                local_path = await self._download_file(file_info)
                if local_path:
                    await self._queue.enqueue(
                        ItemKind.FILE,
                        {"local_path": local_path, "remote_name": file_info["remote_name"]},
                    )
                    enqueued["file"] = enqueued.get("file", 0) + 1
                continue
            # 链接 / 文本
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
        if new_offset > offset:
            await self._offset.save(self._token, new_offset)
        return CollectResult(enqueued=enqueued, meta={"platform": "telegram"})

    def _detect_file(self, msg: dict) -> dict | None:
        """检测 msg 中的文件，返回 {file_id, file_type, remote_name} 或 None。"""
        for field, ftype in _FILE_TYPE_MAP.items():
            entry = msg.get(field)
            if not entry:
                continue
            if field == "photo" and isinstance(entry, list):  # photo 多尺寸，取最大（末尾）
                entry = entry[-1]
            file_id = entry.get("file_id")
            if not file_id:
                continue
            ext = self._ext_for(ftype, entry)
            name = entry.get("file_name") or f"{ftype}-{entry.get('file_unique_id', 'x')}{ext}"
            return {"file_id": file_id, "file_type": ftype, "remote_name": name}
        return None

    def _ext_for(self, ftype: str, entry: dict) -> str:
        """推断后缀：优先 file_name，否则按类型默认。"""
        if entry.get("file_name"):
            return os.path.splitext(entry["file_name"])[1]
        return _DEFAULT_EXT.get(ftype, "")

    async def _download_file(self, file_info: dict) -> str | None:
        """getFile → 下载到暂存目录 → 返回 local_path。失败返回 None。"""
        try:
            r1 = await self._http.get(
                f"{TELEGRAM_API}/bot{self._token}/getFile",
                params={"file_id": file_info["file_id"]},
            )
            file_path = r1.json()["result"]["file_path"]
            r2 = await self._http.get(f"{TELEGRAM_API}/file/bot{self._token}/{file_path}")
            local = os.path.join(self._staging, file_info["remote_name"])
            with open(local, "wb") as f:
                f.write(r2.content)
            return local
        except Exception:
            return None
