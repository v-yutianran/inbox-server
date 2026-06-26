"""flomo 目的地插件。

POST webhook，body {content, content_type:"markdown"}。code==0 成功。
（来自 inbox_sync.save_to_flomo）
"""

from __future__ import annotations

import httpx

from inboxserver.domain.models import ItemKind
from inboxserver.plugins.contracts import DispatchOutcome


class FlomoDestination:
    name = "flomo"
    item_kind = ItemKind.TEXT
    required_config = ["webhook"]

    def __init__(self, config: dict, http: httpx.AsyncClient):
        self._webhook = config["webhook"]
        self._http = http

    async def dispatch(self, item: dict) -> tuple[bool, DispatchOutcome]:
        content = item["content"]
        try:
            resp = await self._http.post(
                self._webhook, json={"content": content, "content_type": "markdown"}
            )
            data = resp.json()
        except Exception:
            return False, DispatchOutcome.FAIL
        ok = data.get("code") == 0
        return ok, DispatchOutcome.OK if ok else DispatchOutcome.FAIL
