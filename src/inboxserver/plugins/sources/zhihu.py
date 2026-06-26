"""知乎来源（浏览器源）：代登录抓收藏 → 解析 → 增量去重 → 智能标签 → 入队 link。

收藏 API：/api/v4/collections/<collection_id>/items（参考 export_zhihu.mjs 真实路径）。
抓取在 zhihu.com 页面内 fetch（浏览器自动签 x-zse-），storage_state 带 z_c0。
401 → mark_expired + 重试一次（代登录自动恢复）。
"""

from __future__ import annotations

import json

from inboxserver.domain.models import Bookmark, ItemKind
from inboxserver.domain.policy.tags import fmt_cubox_tags
from inboxserver.infrastructure.browser.scraper import LoginExpired, Scraper
from inboxserver.infrastructure.browser.session_manager import LoginSessionManager
from inboxserver.infrastructure.llm import generate_smart_tags
from inboxserver.infrastructure.persistence.repositories.baseline import IncrementalBaselineRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult, SourceKind


def parse_zhihu_collections(body_text: str) -> list[Bookmark]:
    """解析知乎收藏 API 响应 → [Bookmark]。

    结构（/api/v4/collections/<id>/items）：{data: [{content: {url, title}}, ...], paging: {...}}
    兼容 content 字段缺失（直接用 entry）；title 缺失回退 url。
    """
    try:
        data = json.loads(body_text)
    except Exception:
        return []
    items: list[Bookmark] = []
    for entry in data.get("data", []):
        content = entry.get("content") or entry
        url = content.get("url")
        if url:
            title = content.get("title", "") or url
            items.append(Bookmark(url=url, title=title))
    return items


class ZhihuSource:
    name = "zhihu"
    kind = SourceKind.BROWSER
    required_config = ["credential_name", "collection_id"]

    def __init__(
        self,
        config: dict,
        session_manager: LoginSessionManager,
        scraper: Scraper,
        queue_repo: RedisQueueRepository,
        http,
        llm_api_key: str,
        baseline_repo: IncrementalBaselineRepo,
    ):
        self._credential_name = config["credential_name"]
        self._collection_id = config["collection_id"]
        self._session = session_manager
        self._scraper = scraper
        self._queue = queue_repo
        self._http = http
        self._llm_key = llm_api_key
        self._baseline = baseline_repo

    async def collect(self) -> CollectResult:
        api_path = f"/api/v4/collections/{self._collection_id}/items?offset=0&limit=20"
        try:
            result = await self._fetch_with_relogin(api_path)
        except Exception as e:  # 抓取彻底失败：记录错误，不阻塞其他源
            return CollectResult(meta={"platform": "zhihu", "error": repr(e)})

        bookmarks = parse_zhihu_collections(result.get("body", ""))
        known = await self._baseline.get_known("zhihu")
        new = [b for b in bookmarks if b.url not in known]
        if not new:
            return CollectResult(skipped=len(bookmarks), meta={"platform": "zhihu"})

        link_count = 0
        for b in new:
            tags = await generate_smart_tags(self._http, b.title, self._llm_key)
            await self._queue.enqueue(
                ItemKind.LINK, {"url": b.url, "title": b.title, "tags": fmt_cubox_tags(tags)}
            )
            link_count += 1
        await self._baseline.save_known("zhihu", known | {b.url for b in new})
        return CollectResult(
            enqueued={"link": link_count},
            skipped=len(bookmarks) - len(new),
            meta={"platform": "zhihu", "new": len(new)},
        )

    async def _fetch_with_relogin(self, path: str) -> dict:
        """抓取，遇 401(LoginExpired) → mark_expired + 重试一次。"""
        storage_state = await self._session.acquire("zhihu", self._credential_name)
        try:
            return await self._scraper.fetch_via_page("zhihu", storage_state, path)
        except LoginExpired:
            await self._session.mark_expired("zhihu")
            storage_state = await self._session.acquire("zhihu", self._credential_name)
            return await self._scraper.fetch_via_page("zhihu", storage_state, path)
