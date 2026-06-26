"""FastAPI 依赖：db session / http client / redis。

每请求创建（MVP）；生产可优化为 lifespan 级单例（http/redis 连接池复用）。
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import redis.asyncio as aioredis

from inboxserver.config.settings import settings
from inboxserver.infrastructure.http_client import make_http_client
from inboxserver.infrastructure.persistence.db import get_session


async def get_http() -> AsyncIterator[httpx.AsyncClient]:
    """每请求一个 httpx.AsyncClient（用完 aclose）。"""
    client = make_http_client()
    try:
        yield client
    finally:
        await client.aclose()


async def get_redis() -> AsyncIterator:
    """每请求一个 redis client。"""
    r = aioredis.from_url(settings.redis_url)
    try:
        yield r
    finally:
        await r.aclose()


# 重导出 get_session 方便路由统一从 deps 导入
__all__ = ["get_http", "get_redis", "get_session"]
