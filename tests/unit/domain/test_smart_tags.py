"""GLM 智能标签解析/构建测试（build_glm_prompt/parse_glm_response）。"""

from inboxserver.domain.policy.smart_tags import build_glm_prompt, parse_glm_response


def test_parse_comma_separated():
    assert parse_glm_response("读书笔记,时间管理,效率工具") == ["读书笔记", "时间管理", "效率工具"]


def test_parse_chinese_punctuation_and_newline():
    """顿号/换行也能切分。"""
    assert parse_glm_response("读书、时间管理\n效率") == ["读书", "时间管理", "效率"]


def test_parse_cleans_noise():
    """含 #/空格 的标签被清洗合并。"""
    assert parse_glm_response("#读书 笔记, 时间管理") == ["读书笔记", "时间管理"]


def test_parse_takes_first_three():
    """超过 3 个只取前 3。"""
    assert parse_glm_response("一一,二二,三三,四四,五五") == ["一一", "二二", "三三"]


def test_parse_filters_short_tags():
    """len < 2 的标签被过滤。"""
    assert parse_glm_response("读,读书,读书人") == ["读书", "读书人"]


def test_parse_empty():
    assert parse_glm_response("") == []
    assert parse_glm_response(None) == []


def test_build_prompt_contains_content_and_constraint():
    p = build_glm_prompt("some content here")
    assert "some content here" in p
    assert "3 个" in p  # 强约束提示
