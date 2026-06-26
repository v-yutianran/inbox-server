"""async engine + session factory（生产用 PG，测试用 sqlite 注入 session）。

模块级 engine 绑定 settings.database_url（懒连接，import 不实际连 DB）。
Repository 接受 session 注入，测试用 sqlite 内存 session，不依赖此 engine。
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from inboxserver.config.settings import settings

# 生产 engine（PG asyncpg）。create_async_engine 懒连接，无 PG 也不报错。
engine = create_async_engine(settings.database_url, echo=False)
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncSession:
    """FastAPI 依赖：每请求一个 session。"""
    async with async_session_factory() as session:
        yield session
