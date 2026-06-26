"""Cubox 目的地插件。

POST api_url，body {type:"url", content, title, tags:[数组]}。
  code==200 成功；code==-3030 配额超（→QUOTA）；非 JSON 响应兜底用 HTTP status。
（来自 inbox_sync.save_to_cubox；tags 必须数组，逗号串会被 API 拒）
"""

from __future__ import annotations

import httpx

from inboxserver.domain.models import ItemKind
from inboxserver.plugins.contracts import DispatchOutcome


class CuboxDestination:
    name = "cubox"
    item_kind = ItemKind.LINK
    required_config = ["api_url"]

    def __init__(self, config: dict, http: httpx.AsyncClient):
        self._api_url = config["api_url"]
        self._http = http

    async def dispatch(self, item: dict) -> tuple[bool, DispatchOutcome]:
        url = item["url"]
        title = item.get("title") or url
        tags = item.get("tags") or []
        try:
            resp = await self._http.post(
                self._api_url,
                json={"type": "url", "content": url, "title": title, "tags": tags},
            )
        except Exception:
            return False, DispatchOutcome.FAIL
        # 解析业务 code
        try:
            data = resp.json()
            code = data.get("code")
        except Exception:
            # 非 JSON 响应：兜底用 HTTP status（现有 save_to_cubox 逻辑）
            ok = resp.is_success
            return ok, DispatchOutcome.OK if ok else DispatchOutcome.FAIL
        if code == 200:
            return True, DispatchOutcome.OK
        if code == -3030:
            return False, DispatchOutcome.QUOTA
        return False, DispatchOutcome.FAIL
