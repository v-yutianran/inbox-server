"""坚果云目的地插件。

WebDAV PUT 到 {base_path}/{remote_name}，Basic Auth。
（来自 inbox_sync.upload_to_webdav）。webdav3 client 同步，用 asyncio.to_thread 包装。
webdav_client 可注入（测试 mock）；不传则内部延迟 import webdav3.client。
"""

from __future__ import annotations

import asyncio

from inboxserver.domain.models import ItemKind
from inboxserver.plugins.contracts import DispatchOutcome


class JianguoyunDestination:
    name = "jianguoyun"
    item_kind = ItemKind.FILE
    required_config = ["webdav_user", "webdav_pass"]

    def __init__(self, config: dict, webdav_client=None):
        self._base_path = config.get("base_path", "/我的坚果云")
        if webdav_client is not None:
            self._client = webdav_client
        else:
            # 延迟 import：避免顶层强依赖 webdav3，且生产/测试分离
            from webdav3.client import Client as WebdavClient

            self._client = WebdavClient(
                {
                    "webdav_hostname": config.get("base_url", "https://dav.jianguoyun.com/dav"),
                    "webdav_login": config["webdav_user"],
                    "webdav_password": config["webdav_pass"],
                }
            )

    async def dispatch(self, item: dict) -> tuple[bool, DispatchOutcome]:
        local_path = item["local_path"]
        remote = f"{self._base_path}/{item['remote_name']}"
        try:
            await asyncio.to_thread(self._client.upload_file, remote, local_path)
            return True, DispatchOutcome.OK
        except Exception:
            return False, DispatchOutcome.FAIL
