"""LoginSessionManager：代登录编排（命门）。

acquire(platform)：有效 session（active+未过期+validate 通过）则复用；
  否则（无/过期/失效）调 strategy.refresh 重登并 upsert，返回新 storage_state。
mark_expired：抓取遇 401 时标记失效，下次 acquire 触发重登。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from inboxserver.infrastructure.browser.pool import BrowserPool
from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo
from inboxserver.infrastructure.persistence.repositories.login_session import LoginSessionRepo
from inboxserver.plugins.contracts import LoginStrategy


class LoginSessionManager:
    def __init__(
        self,
        pool: BrowserPool,
        vault: CredentialVault,
        credential_repo: CredentialRepo,
        session_repo: LoginSessionRepo,
        strategies: dict[str, LoginStrategy],
        session_ttl_days: int = 7,
    ):
        self._pool = pool
        self._vault = vault
        self._cred = credential_repo
        self._sessions = session_repo
        self._strategies = strategies
        self._ttl_days = session_ttl_days

    async def acquire(self, platform: str, credential_name: str) -> dict:
        """获取 platform 的可用 storage_state：有效则复用，过期/失效则重登。"""
        row = await self._sessions.get(platform)
        now = datetime.now(UTC)
        if row and row.status == "active" and row.expires_at and row.expires_at > now:
            storage_state = self._vault.decrypt(row.storage_state_encrypted)
            strategy = self._strategies.get(platform)
            # 乐观复用 + 兜底校验：未到期也要 validate 探测（z_c0 可能被服务端撤销）
            if strategy is None or await strategy.validate(storage_state):
                await self._sessions.touch_used(platform)
                return storage_state
        return await self._refresh(platform, credential_name)

    async def _refresh(self, platform: str, credential_name: str) -> dict:
        strategy = self._strategies.get(platform)
        if strategy is None:
            raise ValueError(f"无 {platform} 的 LoginStrategy")
        encrypted = await self._cred.get_encrypted(credential_name)
        if encrypted is None:
            raise ValueError(f"凭据 {credential_name} 不存在")
        credentials = self._vault.decrypt(encrypted)
        storage_state = await strategy.refresh(credentials)
        expires_at = datetime.now(UTC) + timedelta(days=self._ttl_days)
        await self._sessions.upsert(
            platform, self._vault.encrypt(storage_state), "active", expires_at
        )
        await self._pool.invalidate(platform)  # 重登后清旧 context 缓存
        return storage_state

    async def mark_expired(self, platform: str, error: str = "401") -> None:
        """抓取遇 401 时标记失效 + 清 context（下次 acquire 重登）。"""
        await self._sessions.mark_status(platform, "expired", last_error=error)
        await self._pool.invalidate(platform)
