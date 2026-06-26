"""LoginSessionManager 编排测试（mock strategy/repo/vault/pool）。

命门：三态判定（有效复用 / 过期重登 / validate 失败重登）+ mark_expired。
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

from inboxserver.infrastructure.browser.session_manager import LoginSessionManager


def _build(validate=True, row=None, cred_encrypted=b"enc-cred"):
    vault = MagicMock()
    vault.decrypt.return_value = {"c": 1}  # storage_state / credentials 通用占位
    vault.encrypt.return_value = b"enc-state"
    cred_repo = AsyncMock()
    cred_repo.get_encrypted.return_value = cred_encrypted
    sessions = AsyncMock()
    sessions.get.return_value = row
    pool = AsyncMock()
    strategy = AsyncMock()
    strategy.validate.return_value = validate
    strategy.refresh.return_value = {"new": True}
    mgr = LoginSessionManager(pool, vault, cred_repo, sessions, {"zhihu": strategy})
    return mgr, sessions, pool, strategy


def _active_row():
    row = MagicMock()
    row.status = "active"
    row.expires_at = datetime.now(UTC) + timedelta(days=1)
    row.storage_state_encrypted = b"enc-state"
    return row


async def test_acquire_reuses_valid_session():
    """有效 session（active + 未过期 + validate 通过）→ 复用，不重登。"""
    mgr, sessions, pool, strategy = _build(validate=True, row=_active_row())
    state = await mgr.acquire("zhihu", "cred")
    assert state == {"c": 1}
    strategy.refresh.assert_not_called()
    sessions.touch_used.assert_called_once_with("zhihu")


async def test_acquire_refreshes_when_no_session():
    """无 session → 重登。"""
    mgr, sessions, pool, strategy = _build(row=None)
    state = await mgr.acquire("zhihu", "cred")
    assert state == {"new": True}
    strategy.refresh.assert_called_once()
    sessions.upsert.assert_called_once()


async def test_acquire_refreshes_when_expired():
    """session 过期 → 重登。"""
    row = _active_row()
    row.status = "expired"
    mgr, sessions, pool, strategy = _build(row=row)
    state = await mgr.acquire("zhihu", "cred")
    assert state == {"new": True}
    strategy.refresh.assert_called_once()


async def test_acquire_refreshes_when_validate_fails():
    """名义 active 但 validate 失败（z_c0 被撤销）→ 重登。"""
    mgr, sessions, pool, strategy = _build(validate=False, row=_active_row())
    state = await mgr.acquire("zhihu", "cred")
    assert state == {"new": True}
    strategy.refresh.assert_called_once()


async def test_mark_expired_invalidates_pool():
    mgr, sessions, pool, strategy = _build()
    await mgr.mark_expired("zhihu", "401 unauthorized")
    sessions.mark_status.assert_called_once_with("zhihu", "expired", last_error="401 unauthorized")
    pool.invalidate.assert_called_once_with("zhihu")
