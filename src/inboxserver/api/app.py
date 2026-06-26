"""FastAPI app factory。"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from inboxserver.api.routes import health, sync
from inboxserver.config.logging import configure_logging
from inboxserver.config.settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：配日志 + 建表（MVP create_all，生产用 alembic migrate）。"""
    configure_logging(settings.log_level)
    from inboxserver.infrastructure.persistence import models  # noqa: F401 注册所有 ORM
    from inboxserver.infrastructure.persistence.base import Base
    from inboxserver.infrastructure.persistence.db import engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    scheduler = None
    if settings.scheduler_enabled:
        from inboxserver.infrastructure.scheduler import setup_scheduler

        scheduler = setup_scheduler()
        scheduler.start()
    yield
    if scheduler is not None:
        scheduler.shutdown(wait=False)


def create_app() -> FastAPI:
    app = FastAPI(title="inbox-server", version="0.1.0", lifespan=lifespan)
    app.include_router(health.router)
    app.include_router(sync.router)
    return app
