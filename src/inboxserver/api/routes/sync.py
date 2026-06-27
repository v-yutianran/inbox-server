"""POST /sync：触发各来源收集入队。

根据 channels.yaml 启用的 source 创建实例 → collect → 汇总。
"""

from __future__ import annotations

from typing import Annotated

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from inboxserver.api.auth import require_api_key
from inboxserver.api.deps import get_http, get_redis
from inboxserver.config.channels import load_channels
from inboxserver.infrastructure.collectors.orchestrator import run_collect
from inboxserver.infrastructure.persistence.db import get_session
from inboxserver.infrastructure.scheduler import notify_results

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("")
async def sync(
    session: Annotated[AsyncSession, Depends(get_session)],
    http: Annotated[httpx.AsyncClient, Depends(get_http)],
    queue_redis: Annotated[aioredis.Redis, Depends(get_redis)],
    _: Annotated[None, Depends(require_api_key)],
) -> dict:
    """触发同步：跑启用的 source.collect，返回各来源入队摘要。"""
    channels = load_channels()
    results = await run_collect(channels, http, queue_redis, session)
    # 手动 sync 也发同步报告（对齐老 dispatcher 统一入口；通知是附加通道，未配置/失败不阻塞）
    await notify_results(results, channels, http)
    return {"status": "ok", "results": results}
