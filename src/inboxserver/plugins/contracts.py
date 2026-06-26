"""渠道插件契约（Protocol）。

阶段2：Destination + DispatchOutcome。
阶段3 增 LoginStrategy；阶段4 增 Source。新渠道"实现接口 + 注册 + channels.yaml 启用"即用。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Protocol, runtime_checkable

from inboxserver.domain.models import ItemKind


class DispatchOutcome(StrEnum):
    """分发结局（consumer 据此决策重试/配额/DLQ）。"""

    OK = "ok"  # 成功
    QUOTA = "quota"  # 配额超（如 Cubox -3030）→ 停队列等明天，不进 DLQ
    FAIL = "fail"  # 可重试失败 → retry+1，满 3 次进 DLQ


@runtime_checkable
class Destination(Protocol):
    """目的地插件契约：把 item 分发到具体服务（Cubox/flomo/坚果云/自定义）。

    http client 在构造时注入（生产真实 / 测试 respx mock），dispatch 只收 item。
    """

    name: str
    item_kind: ItemKind  # 绑定内容类型（link/text/file）
    required_config: list[str]

    async def dispatch(self, item: dict) -> tuple[bool, DispatchOutcome]:
        """返回 (是否成功, 结局)。成功=OK；配额超=QUOTA；可重试失败=FAIL。"""
        ...


class LoginStrategy(Protocol):
    """代登录策略契约：把客户凭据转成可用的 storage_state（每平台一个实现）。

    refresh：凭据 → storage_state（注入 cookie / OAuth 后导出 context 状态）。
    validate：storage_state 是否仍有效（开 context 探测一个轻量请求）。
    实现需注入 BrowserPool（开 context 用）；本契约只定义输入输出。
    """

    platform: str
    requires_credentials: list[str]

    async def refresh(self, credentials: dict) -> dict:
        """凭据 → storage_state（dict，含 cookies/origins，落库前加密）。"""
        ...

    async def validate(self, storage_state: dict) -> bool:
        """storage_state 是否仍登录有效（探测 API 返回 200 非 401）。"""
        ...


class SourceKind(StrEnum):
    """来源类型：API（纯 HTTP/token）或 BROWSER（需代登录 storage_state）。"""

    API = "api"
    BROWSER = "browser"


@dataclass
class CollectResult:
    """来源收集结果。enqueued 按内容类型计数，skipped 为去重跳过数。"""

    enqueued: dict[str, int] = field(default_factory=dict)
    skipped: int = 0
    meta: dict | None = None


@runtime_checkable
class Source(Protocol):
    """来源插件契约：从某平台收集内容并入队。

    依赖（session_manager/scraper/queue/http 等）在构造时注入；collect 只返回结果。
    新来源：实现此接口 + 注册 + channels.yaml 启用，核心零改。
    """

    name: str
    kind: SourceKind
    required_config: list[str]

    async def collect(self) -> CollectResult:
        ...
