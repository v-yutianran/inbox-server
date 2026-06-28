"""bilibili 稍后再看来源（浏览器源）：页面内 fetch toview API → bvid → 入队 link。

稍后再看（/x/v2/history/toview/web）无分页，单次全量（~349 条）。
与「我的收藏」（BilibiliSource，fav media_id）独立——独立 source + 独立 baseline，
credential 复用 bilibili_creds（同一 SESSDATA），platform 复用 bilibili（.bilibili.com cookie）。
（来自 bilibili-favorites/export_favorites.mjs fetchToView）
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

TOVIEW_API = "https://api.bilibili.com/x/v2/history/toview/web"


def parse_bilibili_toview(body_text: str) -> list[Bookmark]:
    """解析稍后再看 API 响应 → [Bookmark]。{data:{list:[{bvid,title}]}} → bvid 转 url。"""
    try:
        data = json.loads(body_text)
    except Exception:
        return []
    items: list[Bookmark] = []
    for v in (data.get("data") or {}).get("list") or []:
        bvid = v.get("bvid")
        if bvid:
            title = v.get("title", "") or bvid
            items.append(Bookmark(url=f"https://www.bilibili.com/video/{bvid}", title=title))
    return items


class BilibiliToviewSource:
    name = "bilibili_toview"
    kind = SourceKind.BROWSER
    required_config = ["credential_name"]

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
        self._session = session_manager
        self._scraper = scraper
        self._queue = queue_repo
        self._http = http
        self._llm_key = llm_api_key
        self._baseline = baseline_repo

    async def collect(self) -> CollectResult:
        """抓稍后再看（无分页全量）→ 增量去重（baseline）→ 入队 link。"""
        try:
            known = await self._baseline.get_known("bilibili_toview")
            result = await self._fetch_with_relogin(TOVIEW_API)
            bookmarks = parse_bilibili_toview(result.get("body", ""))
            new = [b for b in bookmarks if b.url not in known]
            if not new:
                return CollectResult(skipped=len(bookmarks), meta={"platform": "bilibili_toview"})

            link_count = 0
            for b in new:
                tags = await generate_smart_tags(self._http, b.title, self._llm_key)
                await self._queue.enqueue(
                    ItemKind.LINK, {"url": b.url, "title": b.title, "tags": fmt_cubox_tags(tags)}
                )
                link_count += 1
            await self._baseline.save_known("bilibili_toview", known | {b.url for b in new})
            return CollectResult(
                enqueued={"link": link_count},
                meta={"platform": "bilibili_toview", "new": len(new)},
            )
        except Exception as e:  # 抓取失败：记录错误，不阻塞其他源
            return CollectResult(meta={"platform": "bilibili_toview", "error": repr(e)})

    async def _fetch_with_relogin(self, url: str) -> dict:
        """抓取，遇 401(LoginExpired) → mark_expired + 重试一次。platform 复用 bilibili。"""
        storage_state = await self._session.acquire("bilibili", self._credential_name)
        try:
            return await self._scraper.fetch_via_page("bilibili", storage_state, url)
        except LoginExpired:
            await self._session.mark_expired("bilibili")
            storage_state = await self._session.acquire("bilibili", self._credential_name)
            return await self._scraper.fetch_via_page("bilibili", storage_state, url)
