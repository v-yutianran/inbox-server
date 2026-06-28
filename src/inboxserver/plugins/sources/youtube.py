"""YouTube 来源（浏览器源）：DOM 抓 WL playlist → video_id → 入队 link。

YouTube Watch Later 被 Data API 锁死（2016 起 WL 返回空），只能浏览器 DOM 抓。
多套容器选择器兜底（YouTube DOM 常变）。MVP 首屏（滚动加载 TODO）。
video_id → https://www.youtube.com/watch?v=<id>。
（来自 youtube-watchlater/export_watchlater.mjs）
"""

from __future__ import annotations

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.tags import fmt_cubox_tags
from inboxserver.infrastructure.browser.pool import BrowserPool
from inboxserver.infrastructure.browser.session_manager import LoginSessionManager
from inboxserver.infrastructure.llm import generate_smart_tags
from inboxserver.infrastructure.persistence.repositories.baseline import IncrementalBaselineRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult, SourceKind
from inboxserver.plugins.login_strategies.youtube import YT_BASE

# DOM 提取 video_id（选择器复刻自 export_watchlater.mjs，多套兜底）
_VIDEO_SELECT = r"""() => {
    const seen = new Set();
    const out = [];
    const sels = ['ytd-playlist-video-renderer', 'ytd-playlist-panel-video-renderer',
                  'ytd-compact-video-renderer', 'ytd-rich-item'];
    sels.forEach(s => document.querySelectorAll(s).forEach(c => {
        const a = c.querySelector('a[href*="watch?v="]');
        if (!a) return;
        const m = a.href.match(/watch\?v=([\w-]{6,})/);
        if (!m || seen.has(m[1])) return;
        seen.add(m[1]);
        const title = (a.getAttribute('title') || a.textContent || '').trim();
        out.push({id: m[1], title: title || m[1]});
    }));
    return out;
}"""


class YouTubeSource:
    name = "youtube"
    kind = SourceKind.BROWSER
    required_config = ["credential_name"]

    def __init__(
        self,
        config: dict,
        session_manager: LoginSessionManager,
        pool: BrowserPool,
        queue_repo: RedisQueueRepository,
        http,
        llm_api_key: str,
        baseline_repo: IncrementalBaselineRepo,
    ):
        self._credential_name = config["credential_name"]
        self._session = session_manager
        self._pool = pool
        self._queue = queue_repo
        self._http = http
        self._llm_key = llm_api_key
        self._baseline = baseline_repo

    async def collect(self) -> CollectResult:
        try:
            storage_state = await self._session.acquire("youtube", self._credential_name)
        except Exception as e:
            return CollectResult(meta={"platform": "youtube", "error": repr(e)})

        ctx = await self._pool.context_for("youtube", storage_state)
        page = await ctx.new_page()
        try:
            await page.goto(f"{YT_BASE}/playlist?list=WL", wait_until="networkidle")
            if "accounts.google.com" in page.url:
                await self._session.mark_expired("youtube")
                return CollectResult(meta={"platform": "youtube", "error": "未登录"})
            # 无限滚动加载：循环 evaluate + 滚动到底 + wait，累积去重直到无新内容
            items = []
            seen: set[str] = set()
            for _ in range(20):
                batch = await page.evaluate(_VIDEO_SELECT)
                fresh = [i for i in batch if i["id"] not in seen]
                if not fresh:
                    break
                items.extend(fresh)
                seen.update(i["id"] for i in fresh)
                await page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
                await page.wait_for_timeout(2000)
        except Exception as e:
            return CollectResult(meta={"platform": "youtube", "error": repr(e)})
        finally:
            await page.close()

        known = await self._baseline.get_known("youtube")
        new = [i for i in items if i["id"] not in known]
        if not new:
            return CollectResult(skipped=len(items), meta={"platform": "youtube"})

        link_count = 0
        for i in new:
            url = f"{YT_BASE}/watch?v={i['id']}"
            tags = await generate_smart_tags(self._http, i["title"], self._llm_key)
            await self._queue.enqueue(
                ItemKind.LINK, {"url": url, "title": i["title"], "tags": fmt_cubox_tags(tags)}
            )
            link_count += 1
        await self._baseline.save_known("youtube", known | {i["id"] for i in new})
        return CollectResult(
            enqueued={"link": link_count},
            skipped=len(items) - len(new),
            meta={"platform": "youtube", "new": len(new)},
        )
