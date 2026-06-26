"""目的地编排：按 channels config 创建启用的 destination 实例，按 item_kind 索引。"""

from __future__ import annotations

from inboxserver.config.channels import ChannelsConfig
from inboxserver.domain.models import ItemKind
from inboxserver.plugins.contracts import Destination
from inboxserver.plugins.registry import load_destinations


def build_destinations(channels: ChannelsConfig, http) -> dict[ItemKind, Destination]:
    """创建启用的 destination 实例。

    jianguoyun 构造不接 http（内部用 webdav client），其余接 http。
    """
    reg = load_destinations()
    dests: dict[ItemKind, Destination] = {}
    for name, entry in channels.enabled_destinations().items():
        cls = reg.get(name)
        if cls is None:
            continue
        if name == "jianguoyun":
            dest = cls(entry.config)
        else:
            dest = cls(entry.config, http)
        dests[dest.item_kind] = dest
    return dests
