"""日志通知器（MVP 默认兜底，结构化日志）。"""

from __future__ import annotations

import structlog


class LogNotifier:
    """把通知写入 structlog（JSON），便于私有化部署接 ELK/Loki。"""

    async def notify(self, message: str) -> None:
        structlog.get_logger().info("notification", message=message)
