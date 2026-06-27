"""Netscape 书签 HTML 解析测试。"""

from inboxserver.domain.policy.netscape import parse_netscape_bookmarks


def test_parse_single():
    html = '<DT><A HREF="https://example.com">示例</A>'
    items = list(parse_netscape_bookmarks(html))
    assert len(items) == 1
    assert items[0].url == "https://example.com"
    assert items[0].title == "示例"


def test_parse_multiple_with_attrs():
    html = (
        '<DT><A HREF="https://a.com">A</A>\n'
        '<DT><A HREF="https://b.com" ADD_DATE="123">B</A>'
    )
    items = list(parse_netscape_bookmarks(html))
    assert [i.url for i in items] == ["https://a.com", "https://b.com"]


def test_parse_unescapes_html_entities():
    html = '<A HREF="https://x.com?a=1&amp;b=2">标题&amp;内容</A>'
    items = list(parse_netscape_bookmarks(html))
    assert items[0].url == "https://x.com?a=1&b=2"
    assert items[0].title == "标题&内容"


def test_parse_case_insensitive():
    html = '<a href="https://c.com">C</a>'
    items = list(parse_netscape_bookmarks(html))
    assert items[0].url == "https://c.com"


def test_parse_empty_or_no_bookmarks():
    assert list(parse_netscape_bookmarks("")) == []
    assert list(parse_netscape_bookmarks("<html>no bookmarks here</html>")) == []
