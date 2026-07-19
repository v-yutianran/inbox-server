"""FastAPI app factory。"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from inboxserver.api.routes import channels, health, login, operations, queue, sync
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
    app.state.scheduler = scheduler
    yield
    if scheduler is not None:
        scheduler.shutdown(wait=False)


def create_app(*, web_dist: Path | None = None) -> FastAPI:
    app = FastAPI(title="inbox-server", version="0.1.0", lifespan=lifespan)
    app.include_router(health.router)
    app.include_router(sync.router)
    app.include_router(queue.router)
    app.include_router(channels.router)
    app.include_router(login.router)
    app.include_router(operations.router)
    dist = web_dist or Path(__file__).resolve().parents[3] / "web" / "dist"
    index = dist / "index.html"
    assets = dist / "assets"
    if index.is_file() and assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="console-assets")
        app.add_api_route(
            "/",
            lambda: FileResponse(index),
            methods=["GET"],
            include_in_schema=False,
        )
    return app
