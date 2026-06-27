"""urls 纯函数测试：md 链接解析、裸 url、extract_url_and_title 4 分支（复刻老 dispatcher）。"""

from __future__ import annotations

from inboxserver.domain.policy.urls import (
    extract_first_url,
    extract_url_and_title,
    extract_url_title_pairs,
)


# ── extract_url_title_pairs（telegram 用，回归保护）──
def test_extract_pairs_md_link():
    pairs = extract_url_title_pairs("[标题](https://e.com)")
    assert pairs == [("https://e.com", "标题")]


def test_extract_pairs_bare_url():
    pairs = extract_url_title_pairs("看看 https://e.com 呀")
    assert pairs == [("https://e.com", "https://e.com")]


def test_extract_pairs_empty():
    assert extract_url_title_pairs("") == []


# ── extract_first_url ──
def test_extract_first_url():
    assert extract_first_url("见 https://e.com/x") == "https://e.com/x"
    assert extract_first_url("无链接") is None


# ── extract_url_and_title（dida 用，复刻老 dispatcher 4 分支）──
def test_euat_md_link():
    """标题是 md 链接 → 剥离 md，得干净标题（核心修复点）"""
    url, title = extract_url_and_title("[干净的标题](https://e.com)")
    assert url == "https://e.com"
    assert title == "干净的标题"


def test_euat_bare_url_title():
    """标题是裸 url → 无好标题，回退用 url"""
    url, title = extract_url_and_title("https://e.com")
    assert url == "https://e.com"
    assert title == ""


def test_euat_content_starts_http():
    """content 以 http 开头 → 用 title 作标题"""
    url, title = extract_url_and_title("我的收藏", "https://e.com/note")
    assert url == "https://e.com/note"
    assert title == "我的收藏"


def test_euat_content_contains_url():
    """content 含 url → 用 title 作标题"""
    url, title = extract_url_and_title("读后感", "正文见 https://e.com/a 结束")
    assert url == "https://e.com/a"
    assert title == "读后感"


def test_euat_no_url():
    """标题/内容都无 url → (None, None)，不入队"""
    url, title = extract_url_and_title("纯文本任务", "无链接内容")
    assert url is None
    assert title is None
