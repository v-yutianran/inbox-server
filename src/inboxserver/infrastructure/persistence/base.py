"""SQLAlchemy DeclarativeBase（所有 ORM 模型的基类）。"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
