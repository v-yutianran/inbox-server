"""健康检查：/healthz（进程存活）/readyz（依赖就绪）。"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz() -> dict:
    """进程存活探针（K8s liveness）。"""
    return {"status": "ok"}


@router.get("/readyz")
async def readyz() -> dict:
    """依赖就绪探针。MVP：进程起来即 ready（redis/db ping 后续补）。"""
    return {"status": "ready"}
