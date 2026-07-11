"""X 来源（浏览器源）：DOM 抓 Bookmarks + Likes → tweet id 去重 → 入队 link。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

from inboxserver.domain.models import ItemKind
from inboxserver.domain.policy.tags import fmt_cubox_tags
from inboxserver.infrastructure.browser.pool import BrowserPool
from inboxserver.infrastructure.browser.session_manager import LoginSessionManager
from inboxserver.infrastructure.persistence.repositories.baseline import IncrementalBaselineRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository
from inboxserver.plugins.contracts import CollectResult, SourceKind
from inboxserver.plugins.login_strategies.x import X_BASE, is_x_login_url

X_GLOBAL_BASELINE = "x"
X_BOOKMARKS_SOURCE = "x_bookmarks"
X_LIKES_SOURCE = "x_likes"
X_SOURCE_NAMES = (X_BOOKMARKS_SOURCE, X_LIKES_SOURCE)

_STATUS_RE = re.compile(r"/status/(\d+)")
_USERNAME_DENYLIST = {"home", "i", "explore", "notifications", "messages", "search"}

_TWEET_SELECT = r"""() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
        const link = Array.from(article.querySelectorAll('a[href*="/status/"]'))
            .map(a => a.href || a.getAttribute('href') || '')
            .find(Boolean) || '';
        const match = link.match(/\/status\/(\d+)/);
        if (!match || seen.has(match[1])) return;
        seen.add(match[1]);
        const author = (
            article.querySelector('div[data-testid="User-Name"]')?.textContent || ''
        ).trim().replace(/\s+/g, ' ');
        const text = Array.from(article.querySelectorAll('div[data-testid="tweetText"]'))
            .map(n => n.textContent || '')
            .join(' ')
            .trim()
            .replace(/\s+/g, ' ');
        out.push({id: match[1], url: link, author, text});
    });
    return out;
}"""


@dataclass(frozen=True)
class XTweet:
    id: str
    url: str
    author: str = ""
    text: str = ""


@dataclass(frozen=True)
class XTimeline:
    source_name: str
    url: str
    tag: str


def parse_x_tweets(raw_items: list[dict]) -> list[XTweet]:
    """把页面 evaluate 返回的原始 dict 清洗为 XTweet，按 tweet id 去重。"""
    tweets: list[XTweet] = []
    seen: set[str] = set()
    for item in raw_items:
        tweet_id = _extract_tweet_id(item)
        if not tweet_id or tweet_id in seen:
            continue
        url = _normalize_tweet_url(str(item.get("url") or ""), tweet_id)
        tweets.append(
            XTweet(
                id=tweet_id,
                url=url,
                author=_clean_text(str(item.get("author") or "")),
                text=_clean_text(str(item.get("text") or "")),
            )
        )
        seen.add(tweet_id)
    return tweets


def build_x_payload(tweet: XTweet, source_tags: list[str]) -> dict:
    """构造 Cubox link payload。"""
    title = _tweet_title(tweet)
    return {"url": tweet.url, "title": title, "tags": fmt_cubox_tags(["x", *source_tags])}


def _extract_tweet_id(item: dict) -> str | None:
    raw_id = str(item.get("id") or "").strip()
    if raw_id.isdigit():
        return raw_id
    match = _STATUS_RE.search(str(item.get("url") or ""))
    return match.group(1) if match else None


def _normalize_tweet_url(raw_url: str, tweet_id: str) -> str:
    absolute = urljoin(X_BASE, raw_url)
    parts = [p for p in urlsplit(absolute).path.split("/") if p]
    username = ""
    if len(parts) >= 3 and parts[-2] == "status":
        username = parts[-3]
    if username and username not in _USERNAME_DENYLIST:
        return f"{X_BASE}/{username}/status/{tweet_id}"
    return f"{X_BASE}/i/web/status/{tweet_id}"


def _clean_text(value: str) -> str:
    return " ".join(value.split())


def _tweet_title(tweet: XTweet) -> str:
    text = tweet.text[:140]
    if tweet.author and text:
        return f"{tweet.author}: {text}"
    return tweet.author or text or tweet.url


class XPlaywrightSource:
    name = "x"
    kind = SourceKind.BROWSER
    required_config = ["credential_name"]

    def __init__(
        self,
        configs: dict[str, dict],
        session_manager: LoginSessionManager,
        pool: BrowserPool,
        queue_repo: RedisQueueRepository,
        http,
        llm_api_key: str,
        baseline_repo: IncrementalBaselineRepo,
        *,
        max_scrolls: int = 20,
        scroll_wait_ms: int = 2000,
    ):
        self._configs = {k: v for k, v in configs.items() if k in X_SOURCE_NAMES}
        self._credential_name = self._resolve_credential_name()
        self._session = session_manager
        self._pool = pool
        self._queue = queue_repo
        self._baseline = baseline_repo
        self._max_scrolls = max_scrolls
        self._scroll_wait_ms = scroll_wait_ms

    async def collect(self) -> dict[str, CollectResult]:
        if not self._configs:
            return {}
        try:
            storage_state = await self._session.acquire("x", self._credential_name)
        except Exception as e:
            return self._error_results(repr(e))

        ctx = await self._pool.context_for("x", storage_state)
        page = await ctx.new_page()
        try:
            tweets_by_source = await self.scrape_timelines(page)
        except Exception as e:
            return self._error_results(repr(e))
        finally:
            await page.close()

        return await self._enqueue_new(tweets_by_source)

    async def scrape_timelines(self, page) -> dict[str, list[XTweet]]:
        timelines = await self._build_timelines(page)
        tweets_by_source: dict[str, list[XTweet]] = {}
        for timeline in timelines:
            await page.goto(timeline.url, wait_until="networkidle")
            if is_x_login_url(page.url):
                await self._session.mark_expired("x", "未登录")
                raise RuntimeError("未登录")
            tweets_by_source[timeline.source_name] = await self._scrape_timeline(page)
        return tweets_by_source

    async def _build_timelines(self, page) -> list[XTimeline]:
        timelines: list[XTimeline] = []
        if X_BOOKMARKS_SOURCE in self._configs:
            timelines.append(
                XTimeline(X_BOOKMARKS_SOURCE, f"{X_BASE}/i/bookmarks", "x-bookmarks")
            )
        if X_LIKES_SOURCE in self._configs:
            username = self._configs[X_LIKES_SOURCE].get("username")
            if not username:
                username = await self._detect_username(page)
            timelines.append(
                XTimeline(X_LIKES_SOURCE, f"{X_BASE}/{username}/likes", "x-likes")
            )
        return timelines

    async def _detect_username(self, page) -> str:
        await page.goto(f"{X_BASE}/home", wait_until="domcontentloaded")
        if is_x_login_url(page.url):
            await self._session.mark_expired("x", "未登录")
            raise RuntimeError("未登录")
        href = await page.evaluate(
            """() => {
                const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
                return (a && (a.href || a.getAttribute('href'))) || '';
            }"""
        )
        username = _username_from_href(str(href or ""))
        if not username:
            raise RuntimeError("无法识别 X username")
        return username

    async def _scrape_timeline(self, page) -> list[XTweet]:
        try:
            await page.wait_for_selector("article[data-testid='tweet']", timeout=10000)
        except Exception:
            pass
        tweets: list[XTweet] = []
        seen: set[str] = set()
        for _ in range(self._max_scrolls):
            batch = parse_x_tweets(await page.evaluate(_TWEET_SELECT))
            fresh = [tweet for tweet in batch if tweet.id not in seen]
            if not fresh:
                break
            tweets.extend(fresh)
            seen.update(tweet.id for tweet in fresh)
            await page.evaluate("() => window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(self._scroll_wait_ms)
        return tweets

    async def _enqueue_new(
        self, tweets_by_source: dict[str, list[XTweet]]
    ) -> dict[str, CollectResult]:
        global_known = await self._baseline.get_known(X_GLOBAL_BASELINE)
        known_by_source = {
            source: await self._baseline.get_known(source) for source in tweets_by_source
        }

        tweets_by_id: dict[str, XTweet] = {}
        tags_by_id: dict[str, list[str]] = {}
        visible_ids_by_source: dict[str, set[str]] = {}
        for source_name, tweets in tweets_by_source.items():
            tag = "x-bookmarks" if source_name == X_BOOKMARKS_SOURCE else "x-likes"
            visible_ids: set[str] = set()
            for tweet in tweets:
                tweets_by_id.setdefault(tweet.id, tweet)
                tags = tags_by_id.setdefault(tweet.id, [])
                if tag not in tags:
                    tags.append(tag)
                visible_ids.add(tweet.id)
            visible_ids_by_source[source_name] = visible_ids

        new_ids = [tweet_id for tweet_id in tweets_by_id if tweet_id not in global_known]
        for tweet_id in new_ids:
            await self._queue.enqueue(
                ItemKind.LINK,
                build_x_payload(tweets_by_id[tweet_id], tags_by_id[tweet_id]),
            )

        await self._baseline.save_known(X_GLOBAL_BASELINE, global_known | set(tweets_by_id))
        for source_name, visible_ids in visible_ids_by_source.items():
            await self._baseline.save_known(
                source_name, known_by_source[source_name] | visible_ids
            )

        return {
            source_name: self._collect_result(source_name, tweets, set(new_ids))
            for source_name, tweets in tweets_by_source.items()
        }

    def _collect_result(
        self, source_name: str, tweets: list[XTweet], global_new_ids: set[str]
    ) -> CollectResult:
        new_count = sum(1 for tweet in tweets if tweet.id in global_new_ids)
        return CollectResult(
            enqueued={"link": new_count} if new_count else {},
            skipped=len(tweets) - new_count,
            meta={"platform": source_name, "new": new_count},
        )

    def _error_results(self, error: str) -> dict[str, CollectResult]:
        return {
            source_name: CollectResult(meta={"platform": source_name, "error": error})
            for source_name in self._configs
        }

    def _resolve_credential_name(self) -> str:
        for config in self._configs.values():
            credential_name = config.get("credential_name")
            if credential_name:
                return credential_name
        raise ValueError("缺少 credential_name")


def _username_from_href(href: str) -> str:
    path = urlsplit(urljoin(X_BASE, href)).path
    parts = [p for p in path.split("/") if p]
    if not parts:
        return ""
    username = parts[0]
    return "" if username in _USERNAME_DENYLIST else username
