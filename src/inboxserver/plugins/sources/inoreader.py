"""inoreader 来源（浏览器源）：DOM 抓 /starred 文章 → 增量去重 → 智能标签 → 入队 link。

DOM 选择器来自 export_readlater.mjs（article 容器 + 标题链接 + article_id 去重 key）。
登录用 storage_state（全 session）。MVP 首屏抓取（无限滚动加载留待 e2e 完善）。
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
from inboxserver.plugins.login_strategies.inoreader import INOREADER_BASE

# DOM 抓取 evaluate（选择器复刻自 export_readlater.mjs）
_ARTICLE_SELECT = r"""() => {
    const titleSel = ['a.article_title_link', 'a.article_title', '.article_title a',
                      'a[data-article-id]', 'h2 a', 'h3 a', 'a.title'];
    const containers = document.querySelectorAll(
        'div.ar.article, div.ar, div.article, [role="article"], article');
    const out = [];
    containers.forEach(c => {
        let titleEl = null;
        for (const s of titleSel) { titleEl = c.querySelector(s); if (titleEl) break; }
        const url = (titleEl && titleEl.href) || '';
        const title = (titleEl && titleEl.textContent && titleEl.textContent.trim()) || '';
        const key = (c.id && /^article_\d+$/.test(c.id))
            ? c.id : (c.getAttribute('data-article-id') || '');
        if (url) out.push({url, title: title || url, key});
    });
    return out;
}"""


class InoreaderSource:
    name = "inoreader"
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
            storage_state = await self._session.acquire("inoreader", self._credential_name)
        except Exception as e:
            return CollectResult(meta={"platform": "inoreader", "error": repr(e)})

        ctx = await self._pool.context_for("inoreader", storage_state)
        page = await ctx.new_page()
        try:
            await page.goto(f"{INOREADER_BASE}/starred", wait_until="networkidle")
            if "/login" in page.url or "/signin" in page.url:
                await self._session.mark_expired("inoreader")
                return CollectResult(meta={"platform": "inoreader", "error": "未登录"})
            # 无限滚动加载：循环 evaluate + 滚动到底 + wait，累积去重直到无新内容
            items = []
            seen = set()
            for _ in range(20):
                batch = await page.evaluate(_ARTICLE_SELECT)
                fresh = [i for i in batch if i.get("key") and i["key"] not in seen]
                if not fresh:
                    break
                items.extend(fresh)
                seen.update(i["key"] for i in fresh)
                await page.evaluate(
                    "() => { const c = document.querySelector("
                    "'#article_list,#river,main,.inno_river');"
                    " if (c) c.scrollTop = c.scrollHeight; }"
                )
                await page.wait_for_timeout(2000)
        except Exception as e:
            return CollectResult(meta={"platform": "inoreader", "error": repr(e)})
        finally:
            await page.close()

        known = await self._baseline.get_known("inoreader")
        new = [i for i in items if i.get("key") and i["key"] not in known]
        if not new:
            return CollectResult(skipped=len(items), meta={"platform": "inoreader"})

        link_count = 0
        for i in new:
            tags = await generate_smart_tags(self._http, i["title"], self._llm_key)
            await self._queue.enqueue(
                ItemKind.LINK, {"url": i["url"], "title": i["title"], "tags": fmt_cubox_tags(tags)}
            )
            link_count += 1
        await self._baseline.save_known("inoreader", known | {i["key"] for i in new})
        return CollectResult(
            enqueued={"link": link_count},
            skipped=len(items) - len(new),
            meta={"platform": "inoreader", "new": len(new)},
        )
