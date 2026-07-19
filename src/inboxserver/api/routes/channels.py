"""渠道列表端点：GET /channels（脱敏返回启用的 source/destination）。

加载 channels.yaml 后只暴露「启用状态 + 引用名」，绝不透出 credentials 段、
llm 段、config 里的 token/webhook 明文。挂 require_api_key（配置属敏感）。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from inboxserver.api.auth import require_api_key
from inboxserver.config.channels import ChannelsConfig, load_channels

router = APIRouter(tags=["channels"])


def safe_channel_summary(channels: ChannelsConfig) -> dict:
    """生成不含 credentials、token 与 webhook 的渠道摘要。"""
    # source：enabled + kind + 凭据引用名（引用名非明文凭据，可安全返回）
    sources: dict[str, dict] = {}
    for name, entry in channels.sources.items():
        sources[name] = {
            "enabled": entry.enabled,
            "kind": entry.kind,
            # channels.yaml 把 credential_name 放在 config dict 里（source 据此引用凭据）
            "credential_name": entry.config.get("credential_name") or entry.credential_ref,
        }
    # destination：enabled + item_kind（不透出 config 里的 webhook/token）
    destinations: dict[str, dict] = {}
    for name, entry in channels.destinations.items():
        destinations[name] = {
            "enabled": entry.enabled,
            "item_kind": entry.item_kind,
        }
    return {"sources": sources, "destinations": destinations}


@router.get("/channels")
async def list_channels(
    _: Annotated[None, Depends(require_api_key)],
) -> dict:
    """渠道列表（脱敏）：返回全部 source/destination 的启用状态与引用信息。"""
    return {"status": "ok", **safe_channel_summary(load_channels())}
