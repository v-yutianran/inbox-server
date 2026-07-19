"""文章归档终态事件 Repository。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.models import ArticleArchiveEvent


class ArticleArchiveEventRepo:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def record(
        self,
        *,
        source_url: str,
        url_fingerprint: str,
        title: str,
        status: str,
        reason: str | None,
        filename: str | None,
    ) -> None:
        self._session.add(
            ArticleArchiveEvent(
                source_url=source_url,
                url_fingerprint=url_fingerprint,
                title=title,
                status=status,
                reason=reason,
                filename=filename,
            )
        )
        await self._session.commit()

    async def list_recent(self, *, limit: int) -> list[ArticleArchiveEvent]:
        result = await self._session.execute(
            select(ArticleArchiveEvent)
            .order_by(ArticleArchiveEvent.occurred_at.desc(), ArticleArchiveEvent.id.desc())
            .limit(limit)
        )
        return list(result.scalars())
