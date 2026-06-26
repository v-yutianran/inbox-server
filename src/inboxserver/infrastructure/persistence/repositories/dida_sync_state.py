"""滴答同步状态 Repository：saved_titles 去重（取代 .dida_cubox_sync.json）。

按 token_hash 隔离；不存明文 token。
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.models import DidaSyncState


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class DidaSyncStateRepo:
    def __init__(self, session: AsyncSession):
        self._s = session

    async def get_saved_titles(self, access_token: str) -> set[str]:
        """获取已转存的任务标题集合（无记录返回空集）。"""
        row = (
            await self._s.execute(
                select(DidaSyncState).where(DidaSyncState.token_hash == hash_token(access_token))
            )
        ).scalar_one_or_none()
        return set(row.saved_titles) if row else set()

    async def save_saved_titles(self, access_token: str, titles: set[str]) -> None:
        """覆盖保存已转存标题 + 更新 last_sync。"""
        existing = (
            await self._s.execute(
                select(DidaSyncState).where(DidaSyncState.token_hash == hash_token(access_token))
            )
        ).scalar_one_or_none()
        now = datetime.now(UTC)
        if existing:
            existing.saved_titles = sorted(titles)
            existing.last_sync = now
        else:
            self._s.add(
                DidaSyncState(
                    token_hash=hash_token(access_token),
                    saved_titles=sorted(titles),
                    last_sync=now,
                )
            )
        await self._s.commit()
