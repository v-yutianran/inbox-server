"""GLM 智能标签：prompt 构建 + 响应解析（纯函数；LLM HTTP 调用在 infrastructure/llm）。

来自 inbox_sync.generate_smart_tags。
  prompt 强约束：3 个 2-6 汉字标签、无空格无标点、逗号分隔
  解析：按逗号/顿号/换行切分 → clean_tag → 取前 3 个 len>=2
"""

from __future__ import annotations

import re

from inboxserver.domain.policy.tags import clean_tag

_MAX_TAGS = 3
_MIN_TAG_LEN = 2
_MAX_CONTENT_CHARS = 1500  # GLM 输入截断，控制 token 成本


def build_glm_prompt(content: str) -> str:
    """构建 GLM 智能标签 prompt（强约束 3 个 2-6 汉字标签）。"""
    snippet = (content or "")[:_MAX_CONTENT_CHARS]
    return (
        "阅读以下内容，提取 3 个最能概括主题的中文标签。\n"
        "严格要求：每个标签 2-6 个汉字，标签内【不能有空格、不能有标点、不能有#号】，"
        "用英文逗号分隔，只输出 3 个标签本身，不要解释、不要编号。\n"
        "示例输出：读书笔记,时间管理,效率工具\n\n"
        f"内容：{snippet}"
    )


def parse_glm_response(text: str | None) -> list[str]:
    """解析 GLM 响应：按逗号/顿号/换行切分 → 清洗 → 取前 3 个 len>=2。"""
    if not text:
        return []
    tags: list[str] = []
    for raw in re.split(r"[，,\n、]", text):
        tag = clean_tag(raw)
        if len(tag) >= _MIN_TAG_LEN:
            tags.append(tag)
    return tags[:_MAX_TAGS]
