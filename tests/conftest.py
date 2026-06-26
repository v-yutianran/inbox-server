"""pytest 共享 fixtures。"""

import os

# 测试环境：sqlite 内存 + 测试 master_key。
# 必须在 import inboxserver 之前设，否则 settings 模块级实例化时读到默认 PG。
os.environ.setdefault("INBOX_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("INBOX_MASTER_KEY", "test-master-key-not-for-prod")

import fakeredis
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from inboxserver.infrastructure.persistence import models  # noqa: F401  注册所有 ORM 模型
from inboxserver.infrastructure.persistence.base import Base


@pytest.fixture
def fake_redis():
    """fakeredis async FakeRedis（每测试隔离，纯内存，零外部依赖）。"""
    return fakeredis.FakeAsyncRedis()


@pytest_asyncio.fixture
async def db_session():
    """sqlite 内存 DB session（每测试隔离，建全部表）。

    生产用 PG，测试用 sqlite 保证零外部依赖。ORM 用通用类型，两种 dialect 都跑。
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()
