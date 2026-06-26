"""API 鉴权：X-API-Key（单租户部署级 key）。

未配置 ADMIN_API_KEY 时开放（开发模式）；配了则强制校验。
"""

from __future__ import annotations

from fastapi import Header, HTTPException, status

from inboxserver.config.settings import settings


async def require_api_key(x_api_key: str | None = Header(None)) -> None:
    """校验 X-API-Key。未配置 key 时放行（开发），否则必须匹配。"""
    if not settings.admin_api_key:
        return
    if x_api_key != settings.admin_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid api key")
