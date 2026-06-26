"""增量基准 Repository：书签源已知 key 集合（防重复抓取）。

取代 backup/zhihu.json 等增量基准文件。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.models import IncrementalBaseline


class IncrementalBaselineRepo:
    def __init__(self, session: AsyncSession):
        self._s = session

    async def get_known(self, source: str) -> set[str]:
        """获取某源的已知 key 集合（无记录返回空集）。"""
        row = (
            await self._s.execute(
                select(IncrementalBaseline).where(IncrementalBaseline.source == source)
            )
        ).scalar_one_or_none()
        return set(row.known_keys) if row else set()

    async def save_known(self, source: str, keys: set[str]) -> None:
        """覆盖保存某源的已知 key 集合（sorted 保证可复现）。"""
        existing = (
            await self._s.execute(
                select(IncrementalBaseline).where(IncrementalBaseline.source == source)
            )
        ).scalar_one_or_none()
        if existing:
            existing.known_keys = sorted(keys)
        else:
            self._s.add(IncrementalBaseline(source=source, known_keys=sorted(keys)))
        await self._s.commit()
