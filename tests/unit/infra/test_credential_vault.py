"""凭据保险箱测试（Fernet 加密）。"""

import pytest

from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault, InvalidToken


def test_encrypt_decrypt_roundtrip():
    vault = CredentialVault(master_key="my-secret-key")
    data = {"z_c0": "abc123", "extra": "x"}
    assert vault.decrypt(vault.encrypt(data)) == data


def test_ciphertext_has_no_plaintext():
    """密文不得包含明文（真加密，非 base64 伪装）。"""
    vault = CredentialVault(master_key="k")
    token = vault.encrypt({"z_c0": "secret_value_xyz"})
    assert b"secret_value_xyz" not in token


def test_wrong_key_raises_invalid_token():
    """不同 MASTER_KEY 解密必须失败（客户隔离的命门）。"""
    vault1 = CredentialVault(master_key="key1")
    vault2 = CredentialVault(master_key="key2")
    token = vault1.encrypt({"a": 1})
    with pytest.raises(InvalidToken):
        vault2.decrypt(token)


def test_missing_master_key_raises():
    with pytest.raises(ValueError, match="MASTER_KEY"):
        CredentialVault(master_key="")
