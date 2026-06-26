"""标签格式化/清洗测试（clean_tag/fmt_cubox_tags/fmt_flomo_tags）。"""

from inboxserver.domain.policy.tags import clean_tag, fmt_cubox_tags, fmt_flomo_tags


def test_clean_tag_removes_whitespace_and_hash():
    assert clean_tag(" 读书 ") == "读书"
    assert clean_tag("#读书") == "读书"


def test_clean_tag_removes_punctuation():
    assert clean_tag("读,书") == "读书"
    assert clean_tag("读。书") == "读书"


def test_fmt_cubox_tags_is_array():
    assert fmt_cubox_tags(["读书", "效率"]) == ["读书", "效率"]


def test_fmt_cubox_tags_github_prefix():
    """is_github=True 前置 'github' 来源标签。"""
    assert fmt_cubox_tags(["读书"], is_github=True) == ["github", "读书"]


def test_fmt_flomo_tags_hash_space_joined():
    assert fmt_flomo_tags(["读书", "效率"]) == "#读书 #效率"
