"""ORM 模型（通用类型，PG/sqlite 皆可）。单租户：无 tenant_id（隔离靠部署边界）。

取代现有文件状态：
  telegram_offsets ← .telegram_offset（update_id 游标）
  dida_sync_states ← .dida_cubox_sync.json（saved_titles 去重）
  incremental_baselines ← backup/zhihu.json（已知收藏基准）
  login_sessions / credentials ← 新（代登录子系统）
  sync_jobs ← 新（/sync 任务记录）
  subscriptions ← 计费预留（MVP 空表）
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, BigInteger, DateTime, Integer, LargeBinary, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from inboxserver.infrastructure.persistence.base import Base


class TelegramOffset(Base):
    __tablename__ = "telegram_offsets"

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    update_id: Mapped[int] = mapped_column(BigInteger)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DidaSyncState(Base):
    __tablename__ = "dida_sync_states"

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    saved_titles: Mapped[list] = mapped_column(JSON, default=list)
    last_sync: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class LoginSession(Base):
    """代登录会话：platform 唯一，storage_state 加密存储。"""

    __tablename__ = "login_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    storage_state_encrypted: Mapped[bytes] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String(16), default="active")  # active/expired/invalid
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Credential(Base):
    """客户凭据保险箱：payload 加密存储（Fernet）。"""

    __tablename__ = "credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    platform: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # cookie/password/token
    payload_encrypted: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class IncrementalBaseline(Base):
    """书签源增量基准：已知 key 集合（防重复抓取）。"""

    __tablename__ = "incremental_baselines"

    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    known_keys: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class SyncJob(Base):
    """/sync 任务记录。"""

    __tablename__ = "sync_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # UUID
    triggered_by: Mapped[str] = mapped_column(String(16))  # api/manual/scheduler
    status: Mapped[str] = mapped_column(String(16), default="running")  # running/done/failed
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class Subscription(Base):
    """计费预留（MVP 空表，subscription 上下文占位）。"""

    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(primary_key=True)
    plan: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    seats: Mapped[int] = mapped_column(Integer, default=1)
    current_period_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
