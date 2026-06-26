"""登录会话 Repository：storage_state（加密 bytes）的存取 + 状态流转。"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.models import LoginSession


class LoginSessionRepo:
    def __init__(self, session: AsyncSession):
        self._s = session

    async def upsert(
        self,
        platform: str,
        storage_state_encrypted: bytes,
        status: str,
        expires_at: datetime,
    ) -> None:
        existing = (
            await self._s.execute(select(LoginSession).where(LoginSession.platform == platform))
        ).scalar_one_or_none()
        if existing:
            existing.storage_state_encrypted = storage_state_encrypted
            existing.status = status
            existing.expires_at = expires_at
            existing.last_error = None
        else:
            self._s.add(
                LoginSession(
                    platform=platform,
                    storage_state_encrypted=storage_state_encrypted,
                    status=status,
                    expires_at=expires_at,
                )
            )
        await self._s.commit()

    async def get(self, platform: str) -> LoginSession | None:
        return (
            await self._s.execute(select(LoginSession).where(LoginSession.platform == platform))
        ).scalar_one_or_none()

    async def mark_status(self, platform: str, status: str, last_error: str | None = None) -> None:
        """更新状态（active/expired/invalid），可选记录 last_error。"""
        row = await self.get(platform)
        if row:
            row.status = status
            if last_error:
                row.last_error = last_error
            await self._s.commit()

    async def touch_used(self, platform: str) -> None:
        """记录最后使用时间（监控 session 活跃度）。"""
        row = await self.get(platform)
        if row:
            row.last_used_at = datetime.now(UTC)
            await self._s.commit()
