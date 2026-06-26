"""凭据 Repository：加密 payload 的存取（加解密在 CredentialVault，本层只存 bytes）。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.infrastructure.persistence.models import Credential


class CredentialRepo:
    def __init__(self, session: AsyncSession):
        self._s = session

    async def upsert(self, name: str, platform: str, kind: str, payload_encrypted: bytes) -> None:
        existing = (
            await self._s.execute(select(Credential).where(Credential.name == name))
        ).scalar_one_or_none()
        if existing:
            existing.platform = platform
            existing.kind = kind
            existing.payload_encrypted = payload_encrypted
        else:
            self._s.add(
                Credential(
                    name=name,
                    platform=platform,
                    kind=kind,
                    payload_encrypted=payload_encrypted,
                )
            )
        await self._s.commit()

    async def get_encrypted(self, name: str) -> bytes | None:
        row = (
            await self._s.execute(select(Credential).where(Credential.name == name))
        ).scalar_one_or_none()
        return row.payload_encrypted if row else None
