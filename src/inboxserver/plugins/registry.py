"""插件注册表：entry_points 加载（主）+ 内置兜底（开发期未声明也能发现）。

新渠道：实现接口 + 在 pyproject 声明 entry_point + channels.yaml 启用，核心零改。
"""

from __future__ import annotations

from importlib.metadata import entry_points


class DestinationRegistry:
    """目的地插件注册表。"""

    def __init__(self):
        self._items: dict[str, type] = {}

    def register(self, name: str, cls: type) -> None:
        self._items[name] = cls

    def get(self, name: str) -> type | None:
        return self._items.get(name)

    def names(self) -> list[str]:
        return list(self._items)

    def all(self) -> dict[str, type]:
        return dict(self._items)


def load_destinations() -> DestinationRegistry:
    """加载目的地插件。

    优先读 entry_points(group=inboxserver.destinations)；为空则兜底注册内置三个插件
    （开发期尚未在 pyproject 声明 entry_point 时也能工作）。
    """
    reg = DestinationRegistry()
    try:
        for ep in entry_points(group="inboxserver.destinations"):
            reg.register(ep.name, ep.load())
    except Exception:
        pass
    if not reg.all():
        # 兜底：内置插件直接注册（开发期 / 未声明 entry_point 时）
        from inboxserver.plugins.destinations.cubox import CuboxDestination
        from inboxserver.plugins.destinations.flomo import FlomoDestination
        from inboxserver.plugins.destinations.jianguoyun import JianguoyunDestination

        reg.register("cubox", CuboxDestination)
        reg.register("flomo", FlomoDestination)
        reg.register("jianguoyun", JianguoyunDestination)
    return reg
