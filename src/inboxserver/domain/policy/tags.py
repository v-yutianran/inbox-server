"""标签格式化与清洗（纯函数，平台无关）。

来自 inbox_sync.fmt_cubox_tags / fmt_flomo_tags + generate_smart_tags 的清洗正则。
  Cubox tags = JSON 数组（逗号串会被 API 拒，必须数组）；is_github 前置 "github"
  flomo tags = "#tag" 空格分隔（'#' 紧跟文字）
"""

from __future__ import annotations

import re

# 标签清洗：去掉空格/#/中英文标点/各类括号引号（来自 generate_smart_tags）
_TAG_NOISE = re.compile(r"[\s#。，,、！!?？:：;；（）()【】\[\]\"'""''`]+")


def clean_tag(raw: str) -> str:
    """清洗单个标签：去空格/#/标点。"""
    return _TAG_NOISE.sub("", raw).strip()


def fmt_cubox_tags(tags: list[str], is_github: bool = False) -> list[str]:
    """Cubox 标签：JSON 数组；is_github 前置 'github' 来源标签。"""
    return (["github"] if is_github else []) + list(tags)


def fmt_flomo_tags(tags: list[str]) -> str:
    """flomo 标签：'#tag' 空格分隔（'#' 紧跟文字）。"""
    return " ".join(f"#{t}" for t in tags)
