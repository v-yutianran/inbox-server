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
