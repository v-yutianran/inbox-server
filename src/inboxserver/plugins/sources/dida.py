"""滴答清单来源（API 源）：inbox 全量拉 → 提取 url 入队 → DELETE 任务。

含 url 的任务入 link 队列；saved_titles 去重；无论是否含 url 都 DELETE 收集箱任务
（保持收集箱干净）。语义同 inbox_sync.sync_dida365。
"""

from __future__ import annotations

import httpx

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.urls import extract_url_and_title
from inboxserver.infrastructure.persistence.repositories.dida_sync_state import DidaSyncStateRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult, SourceKind

DIDA_API = "https://api.dida365.com/open/v1"


class DidaSource:
    name = "dida"
    kind = SourceKind.API
    required_config = ["access_token"]

    def __init__(
        self,
        config: dict,
        http: httpx.AsyncClient,
        queue_repo: RedisQueueRepository,
        state_repo: DidaSyncStateRepo,
    ):
        self._token = config["access_token"]
        self._http = http
        self._queue = queue_repo
        self._state = state_repo

    async def collect(self) -> CollectResult:
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            resp = await self._http.get(f"{DIDA_API}/project/inbox/data", headers=headers)
            tasks = (resp.json() or {}).get("tasks", []) or []
        except Exception as e:
            return CollectResult(meta={"platform": "dida", "error": repr(e)})

        saved = await self._state.get_saved_titles(self._token)
        new_saved = set(saved)
        link_count = 0
        for task in tasks:
            title = task.get("title", "")
            content = task.get("content", "")
            # 复刻老 dispatcher.extract_url_and_title：
            # 从标题/内容提取 url + 干净标题（剥离 md 链接）
            url, clean_title = extract_url_and_title(title, content)
            task_id = task.get("id")
            project_id = task.get("projectId")
            # DELETE 收集箱任务（清理，无论是否含 url —— 与现有 sync_dida365 一致）
            if task_id and project_id:
                try:
                    await self._http.delete(
                        f"{DIDA_API}/project/{project_id}/task/{task_id}", headers=headers
                    )
                except Exception:
                    pass
            if url and title not in saved:
                await self._queue.enqueue(
                    # clean_title 为空（裸 url 场景）时回退 url，保证标题非空
                    ItemKind.LINK, {"url": url, "title": clean_title or url, "tags": []}
                )
                link_count += 1
            new_saved.add(title)
        if new_saved != saved:
            await self._state.save_saved_titles(self._token, new_saved)
        return CollectResult(enqueued={"link": link_count}, meta={"platform": "dida"})
