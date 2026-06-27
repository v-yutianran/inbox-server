"""URL 提取（从文本 / Markdown 链接提取 URL + 标题）。纯函数。"""

from __future__ import annotations

import re

# Markdown 链接 [title](url)
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
# 裸 URL
_URL_RE = re.compile(r"(https?://[^\s<>\]\)]+)")


def extract_url_title_pairs(text: str) -> list[tuple[str, str]]:
    """从文本提取 (url, title) 对：优先 md [title](url)，再裸 url（title 回退 url）。"""
    if not text:
        return []
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in _MD_LINK_RE.finditer(text):
        title, url = m.group(1).strip(), m.group(2).strip()
        if url not in seen:
            pairs.append((url, title or url))
            seen.add(url)
    for m in _URL_RE.finditer(text):
        url = m.group(1).strip().rstrip(".,);]")
        if url not in seen:
            pairs.append((url, url))
            seen.add(url)
    return pairs


def extract_first_url(text: str) -> str | None:
    """提取第一个 URL（无则 None）。"""
    if not text:
        return None
    m = _URL_RE.search(text)
    return m.group(1).strip().rstrip(".,);]") if m else None


def extract_url_and_title(title: str, content: str = "") -> tuple[str | None, str]:
    """从（任务）标题/内容提取 (url, 干净标题)，复刻 inbox_dispatcher.extract_url_and_title。

    4 分支（优先级递减），保证 cubox 书签标题不再残留原始 md 链接格式：
    1. title 是 md 链接 [text](url) → (url, text)  ← 剥离 md，标题干净
    2. title 是裸 url              → (url, "")      ← url 无好标题，回退用 url
    3. content 以 http 开头         → (content首token, title)
    4. content 含 url              → (url, title)
    其余 → (None, None)（该任务不入 link 队列）
    """
    title = title or ""
    content = content or ""

    # 1. title 是 md 链接 [text](url)：剥离 md，取干净标题
    m = _MD_LINK_RE.search(title)
    if m:
        return m.group(2).strip(), m.group(1).strip()

    # 2. title 是裸 url：无好标题
    if title.startswith("http"):
        return title, ""

    # 3. content 以 http 开头：content 首个 token 当 url
    if content.startswith("http"):
        return content.split()[0].rstrip(".,);]"), title

    # 4. content 含 url：用 title 作标题
    m = _URL_RE.search(content)
    if m:
        return m.group(1).strip().rstrip(".,);]"), title

    return None, None
