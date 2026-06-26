"""Telegram update_id 游标 Repository（取代 .telegram_offset 文件）。

按 bot_token_hash 隔离（支持多 bot 预留）；不存明文 token（sha256 hash）。
"""

from __future__ import annotations

import hashlib

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.models import TelegramOffset


def hash_token(token: str) -> str:
    """token → sha256 hex（不存明文，DB 泄露也拿不到原始 token）。"""
    return hashlib.sha256(token.encode()).hexdigest()


class TelegramOffsetRepo:
    def __init__(self, session: AsyncSession):
        self._s = session

    async def get(self, bot_token: str) -> int:
        """获取当前 offset（无记录返回 0，从头开始）。"""
        row = (
            await self._s.execute(
                select(TelegramOffset).where(
                    TelegramOffset.bot_token_hash == hash_token(bot_token)
                )
            )
        ).scalar_one_or_none()
        return row.update_id if row else 0

    async def save(self, bot_token: str, update_id: int) -> None:
        """持久化 offset（upsert）。"""
        existing = (
            await self._s.execute(
                select(TelegramOffset).where(
                    TelegramOffset.bot_token_hash == hash_token(bot_token)
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.update_id = update_id
        else:
            self._s.add(
                TelegramOffset(bot_token_hash=hash_token(bot_token), update_id=update_id)
            )
        await self._s.commit()
