"""uvicorn 入口：python -m inboxserver.main 或 uvicorn inboxserver.main:app。"""

from __future__ import annotations

import uvicorn

from inboxserver.api.app import create_app
from inboxserver.config.settings import settings

app = create_app()


if __name__ == "__main__":
    uvicorn.run("inboxserver.main:app", host=settings.host, port=settings.port, reload=False)
