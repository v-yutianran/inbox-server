"""bilibili 来源（浏览器源）：页面内 fetch api.bilibili.com 收藏 → 解析 → 入队 link。

B站官方 API（带 SESSDATA，跨子域 credentials:include）。media_id 配置（收藏夹 ID）。
bvid → https://www.bilibili.com/video/<bvid>。
（来自 bilibili-favorites/export_favorites.mjs）
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

BILI_API = "https://api.bilibili.com"


def parse_bilibili_favorites(body_text: str) -> list[Bookmark]:
    """解析 B站收藏 API 响应 → [Bookmark]。{data:{medias:[{bvid,title}]}} → bvid 转 url。"""
    try:
        data = json.loads(body_text)
    except Exception:
        return []
    items: list[Bookmark] = []
    for m in (data.get("data") or {}).get("medias") or []:
        bvid = m.get("bvid")
        if bvid:
            title = m.get("title", "") or bvid
            items.append(Bookmark(url=f"https://www.bilibili.com/video/{bvid}", title=title))
    return items


class BilibiliSource:
    name = "bilibili"
    kind = SourceKind.BROWSER
    required_config = ["credential_name", "media_id"]

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
        self._media_id = config["media_id"]
        self._session = session_manager
        self._scraper = scraper
        self._queue = queue_repo
        self._http = http
        self._llm_key = llm_api_key
        self._baseline = baseline_repo

    async def collect(self) -> CollectResult:
        api = f"{BILI_API}/x/v3/fav/resource/list?media_id={self._media_id}&pn=1&ps=20"
        try:
            result = await self._fetch_with_relogin(api)
        except Exception as e:
            return CollectResult(meta={"platform": "bilibili", "error": repr(e)})

        bookmarks = parse_bilibili_favorites(result.get("body", ""))
        known = await self._baseline.get_known("bilibili")
        new = [b for b in bookmarks if b.url not in known]
        if not new:
            return CollectResult(skipped=len(bookmarks), meta={"platform": "bilibili"})

        link_count = 0
        for b in new:
            tags = await generate_smart_tags(self._http, b.title, self._llm_key)
            await self._queue.enqueue(
                ItemKind.LINK, {"url": b.url, "title": b.title, "tags": fmt_cubox_tags(tags)}
            )
            link_count += 1
        await self._baseline.save_known("bilibili", known | {b.url for b in new})
        return CollectResult(
            enqueued={"link": link_count},
            skipped=len(bookmarks) - len(new),
            meta={"platform": "bilibili", "new": len(new)},
        )

    async def _fetch_with_relogin(self, url: str) -> dict:
        """抓取，遇 401(LoginExpired) → mark_expired + 重试一次。"""
        storage_state = await self._session.acquire("bilibili", self._credential_name)
        try:
            return await self._scraper.fetch_via_page("bilibili", storage_state, url)
        except LoginExpired:
            await self._session.mark_expired("bilibili")
            storage_state = await self._session.acquire("bilibili", self._credential_name)
            return await self._scraper.fetch_via_page("bilibili", storage_state, url)
