"""凭据保险箱：Fernet 对称加密。

存 LoginSession.storage_state / Credential.payload。主密钥来自 MASTER_KEY env（每客部署唯一）。
MASTER_KEY 可为任意字符串（用 Scrypt 派生为合法 Fernet key，安全性来自 MASTER_KEY 秘密性）。
加解密是纯字节操作；Repository 只存 bytes，不碰密码学（关注点分离）。
"""

from __future__ import annotations

import base64
import json

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from inboxserver.config.settings import settings

# Scrypt 固定 salt（非秘密，仅防预计算彩虹表；安全性依赖 MASTER_KEY 本身）
_SCRYPT_SALT = b"inboxserver-credential-vault-v1"


class CredentialVault:
    def __init__(self, master_key: str | None = None):
        # 仅 None 时 fallback settings；显式传值（含空串）优先。空串=明确无 key → raise。
        if master_key is None:
            master_key = settings.master_key
        if not master_key:
            raise ValueError("MASTER_KEY 未配置（凭据加密主密钥，每客部署必须设置）")
        self._fernet = Fernet(_derive_fernet_key(master_key))

    def encrypt(self, data: dict) -> bytes:
        """加密 dict → bytes（落库）。"""
        return self._fernet.encrypt(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def decrypt(self, token: bytes) -> dict:
        """解密 bytes → dict。密钥不符抛 InvalidToken。"""
        return json.loads(self._fernet.decrypt(token).decode("utf-8"))


def _derive_fernet_key(master_key: str) -> bytes:
    """从任意 MASTER_KEY 派生合法 Fernet key（urlsafe base64 的 32 字节）。"""
    kdf = Scrypt(salt=_SCRYPT_SALT, length=32, n=2**14, r=8, p=1)
    derived = kdf.derive(master_key.encode("utf-8"))
    return base64.urlsafe_b64encode(derived)


__all__ = ["CredentialVault", "InvalidToken"]
