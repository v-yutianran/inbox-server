"""Netscape 书签 HTML 解析（纯函数）。

来自 inbox_sync.parse_netscape_bookmarks。书签源（知乎/inoreader/YouTube/B站）
统一导出为 Netscape 格式 HTML，此函数解析为 [Bookmark(url, title)]。
"""

from __future__ import annotations

import html as _html
import re

from inboxserver.domain.models import Bookmark

# <A HREF="url" ...>title</A>（大小写不敏感；HREF 前可能有其它属性）
_BOOKMARK_RE = re.compile(r'<A\s+[^>]*HREF="([^"]+)"[^>]*>([^<]*)</A>', re.IGNORECASE)


def parse_netscape_bookmarks(html_text: str):
    """解析 Netscape 书签 HTML → 迭代器 yield Bookmark。HTML 实体自动反转义。

    Generator（Item 30）：大书签（inoreader 1081 条）增量处理，不一次性加载内存。
    """
    if not html_text:
        return
    for m in _BOOKMARK_RE.finditer(html_text):
        url = _html.unescape(m.group(1).strip())
        title = _html.unescape(m.group(2).strip())
        if url:
            yield Bookmark(url=url, title=title)
