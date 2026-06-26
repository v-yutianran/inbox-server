"""凭据 Repository 测试（sqlite 内存 + vault 加解密）。"""

import pytest

from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo


@pytest.fixture
def repo(db_session):
    return CredentialRepo(db_session)


async def test_upsert_and_get_encrypted(repo):
    vault = CredentialVault(master_key="k")
    await repo.upsert("zhihu_main", "zhihu", "cookie", vault.encrypt({"z_c0": "abc"}))
    got = await repo.get_encrypted("zhihu_main")
    assert got is not None
    assert vault.decrypt(got) == {"z_c0": "abc"}


async def test_upsert_overwrites(repo):
    vault = CredentialVault(master_key="k")
    await repo.upsert("c", "zhihu", "cookie", vault.encrypt({"v": 1}))
    await repo.upsert("c", "zhihu", "cookie", vault.encrypt({"v": 2}))
    assert vault.decrypt(await repo.get_encrypted("c")) == {"v": 2}


async def test_get_missing_returns_none(repo):
    assert await repo.get_encrypted("nope") is None
