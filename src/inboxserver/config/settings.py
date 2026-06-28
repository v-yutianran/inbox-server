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

    # 调度
    scheduler_enabled: bool = True  # APScheduler 定时 collect（测试环境关闭）

    # 邮件通知（smtplib 直连 QQ SMTP；去 agently-cli/node 依赖，容器化友好）
    # email_enabled=True 且 smtp 凭据齐全才真发；
    # 否则 LogNotifier 兜底（通知是附加通道，不阻塞主流程）
    email_enabled: bool = False
    smtp_host: str = "smtp.163.com"  # SMTP 主机（默认网易 163；可由 .env 覆盖）
    smtp_port: int = 465  # QQ SMTP over SSL 端口
    smtp_user: str = ""  # 发件 QQ 邮箱地址（如 630709658@qq.com）
    smtp_pass: str = ""  # QQ SMTP 授权码（QQ 邮箱设置开启 SMTP 后生成，非登录密码）
    email_from: str = ""  # 发件人；为空时回退 smtp_user
    email_to: str = "630709658@qq.com"  # 收件人


settings = Settings()
