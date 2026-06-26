"""渠道配置：解析 channels.yaml（声明启用的 source/destination + 参数 + 凭据引用）。

${ENV} 从环境变量插值（凭据不落 yaml 明文）。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

_ENV_RE = re.compile(r"\$\{([^}]+)\}")


@dataclass
class ChannelEntry:
    enabled: bool = False
    config: dict = field(default_factory=dict)
    kind: str | None = None  # source: api/browser
    item_kind: str | None = None  # destination: link/text/file
    credential_ref: str | None = None


@dataclass
class ChannelsConfig:
    sources: dict[str, ChannelEntry] = field(default_factory=dict)
    destinations: dict[str, ChannelEntry] = field(default_factory=dict)
    credentials: dict[str, dict] = field(default_factory=dict)
    llm: dict = field(default_factory=dict)

    def enabled_sources(self) -> dict[str, ChannelEntry]:
        return {k: v for k, v in self.sources.items() if v.enabled}

    def enabled_destinations(self) -> dict[str, ChannelEntry]:
        return {k: v for k, v in self.destinations.items() if v.enabled}


def _interpolate(value):
    """${ENV} 插值（递归 dict/list/str）。"""
    if isinstance(value, str):
        return _ENV_RE.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, dict):
        return {k: _interpolate(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v) for v in value]
    return value


def load_channels(path: str | Path | None = None) -> ChannelsConfig:
    """加载 channels.yaml（不存在/无 yaml 返回空 config，开发期不强制）。"""
    try:
        import yaml
    except ImportError:
        return ChannelsConfig()
    p = Path(path or os.environ.get("INBOX_CHANNELS", "channels.yaml"))
    if not p.exists():
        return ChannelsConfig()
    raw = _interpolate(yaml.safe_load(p.read_text()) or {})
    return ChannelsConfig(
        sources={k: ChannelEntry(**v) for k, v in (raw.get("sources") or {}).items()},
        destinations={k: ChannelEntry(**v) for k, v in (raw.get("destinations") or {}).items()},
        credentials=raw.get("credentials") or {},
        llm=raw.get("llm") or {},
    )
