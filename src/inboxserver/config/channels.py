"""渠道配置：解析 channels.yaml（声明启用的 source/destination + 参数 + 凭据引用）。

${ENV} 从环境变量插值（凭据不落 yaml 明文）。
P1-6：Pydantic BaseModel 替换 dataclass（启动时强类型校验，fail-fast）。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

_ENV_RE = re.compile(r"\$\{([^}]+)\}")


class ChannelEntry(BaseModel):
    """单个渠道配置（source 或 destination）。Pydantic 校验字段类型。"""

    enabled: bool = False
    config: dict[str, str] = Field(default_factory=dict)
    kind: str | None = None  # source: api/browser
    item_kind: str | None = None  # destination: link/text/file
    credential_ref: str | None = None


class ChannelsConfig(BaseModel):
    """全量渠道配置。"""

    sources: dict[str, ChannelEntry] = Field(default_factory=dict)
    destinations: dict[str, ChannelEntry] = Field(default_factory=dict)
    credentials: dict[str, dict] = Field(default_factory=dict)
    llm: dict[str, str] = Field(default_factory=dict)
    notification: dict[str, str] = Field(default_factory=dict)

    def enabled_sources(self) -> dict[str, ChannelEntry]:
        return {k: v for k, v in self.sources.items() if v.enabled}

    def enabled_destinations(self) -> dict[str, ChannelEntry]:
        return {k: v for k, v in self.destinations.items() if v.enabled}


# P1-6：各 source/destination 的 config 强类型模型（按 name 路由，启动 fail-fast 校验）。
# 字段来自各插件实际 config["key"] 用法（见 plugins/sources/*、plugins/destinations/*）。
class TelegramSourceConfig(BaseModel):
    bot_token: str


class DidaSourceConfig(BaseModel):
    access_token: str


class ZhihuSourceConfig(BaseModel):
    credential_name: str
    collection_id: str


class BilibiliSourceConfig(BaseModel):
    credential_name: str
    media_id: str


class BilibiliToviewSourceConfig(BaseModel):
    credential_name: str


class InoreaderSourceConfig(BaseModel):
    credential_name: str


class YoutubeSourceConfig(BaseModel):
    credential_name: str


class CuboxDestinationConfig(BaseModel):
    api_url: str


class FlomoDestinationConfig(BaseModel):
    webhook: str


class JianguoyunDestinationConfig(BaseModel):
    webdav_user: str
    webdav_pass: str


# name → config 模型路由（启动校验时按渠道名选模型）。未注册的渠道跳过校验（自定义插件兼容）。
_SOURCE_CONFIG_MODELS: dict[str, type[BaseModel]] = {
    "telegram": TelegramSourceConfig,
    "dida": DidaSourceConfig,
    "zhihu": ZhihuSourceConfig,
    "bilibili": BilibiliSourceConfig,
    "bilibili_toview": BilibiliToviewSourceConfig,
    "inoreader": InoreaderSourceConfig,
    "youtube": YoutubeSourceConfig,
}
_DESTINATION_CONFIG_MODELS: dict[str, type[BaseModel]] = {
    "cubox": CuboxDestinationConfig,
    "flomo": FlomoDestinationConfig,
    "jianguoyun": JianguoyunDestinationConfig,
}


def _validate_channel(
    name: str,
    entry: ChannelEntry,
    models: dict[str, type[BaseModel]],
    kind: str,
) -> None:
    """校验启用渠道的 config（按 name 路由到 Pydantic 模型，fail-fast）。

    缺字段/类型不符 → 抛 ValueError（带渠道名 + 错误明细），启动即暴露配置错误，
    避免「运行到 source 构造时才 KeyError」的隐蔽故障。
    未注册模型的渠道跳过校验（兼容自定义插件，保持扩展性）。
    """
    if not entry.enabled:
        return
    model = models.get(name)
    if model is None:
        return  # 未注册模型的渠道（自定义/未来新增）不校验
    try:
        model(**entry.config)
    except ValidationError as e:
        raise ValueError(f"渠道配置校验失败 [{kind}/{name}]：{e}") from e


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
    """加载 channels.yaml（不存在/无 yaml 返回空 config，开发期不强制）。

    Pydantic BaseModel 自动校验：字段类型不匹配时启动 fail-fast。
    """
    try:
        import yaml
    except ImportError:
        return ChannelsConfig()
    p = Path(path or os.environ.get("INBOX_CHANNELS", "channels.yaml"))
    if not p.exists():
        return ChannelsConfig()
    raw = _interpolate(yaml.safe_load(p.read_text()) or {})
    cfg = ChannelsConfig(
        sources={k: ChannelEntry(**v) for k, v in (raw.get("sources") or {}).items()},
        destinations={k: ChannelEntry(**v) for k, v in (raw.get("destinations") or {}).items()},
        credentials=raw.get("credentials") or {},
        llm=raw.get("llm") or {},
        notification=raw.get("notification") or {},
    )
    # P1-6：启动 fail-fast 校验启用渠道的 config（缺字段/类型错清晰报错）
    for name, entry in cfg.enabled_sources().items():
        _validate_channel(name, entry, _SOURCE_CONFIG_MODELS, "source")
    for name, entry in cfg.enabled_destinations().items():
        _validate_channel(name, entry, _DESTINATION_CONFIG_MODELS, "destination")
    return cfg
