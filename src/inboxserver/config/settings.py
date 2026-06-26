"""应用配置（pydantic-settings 读 env）。单租户部署：每客独立 env。

业务凭据（Telegram token / Cubox key 等）不在此处，走 channels.yaml + CredentialVault。
这里只放基础设施配置 + 部署级密钥。
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="INBOX_", env_file=".env", extra="ignore")

    # 基础设施连接
    redis_url: str = "redis://localhost:6379/0"
    database_url: str = "postgresql+asyncpg://inbox:inbox@localhost:5432/inbox"

    # 部署级密钥（每客唯一，必须配置）
    master_key: str = ""  # 凭据加密主密钥（Fernet），生产必填
    admin_api_key: str = ""  # API 鉴权 key（X-API-Key）

    # 服务
    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "INFO"


settings = Settings()
