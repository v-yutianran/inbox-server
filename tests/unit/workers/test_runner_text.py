"""runner._make_process_text 测试：text→flomo 智能标签拼接 + GLM 失败兜底。"""

from __future__ import annotations

from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.workers.runner import _make_process_text


class FakeFlomo:
    """假 flomo 目的地：记录最后一次 dispatch 的 content。"""

    def __init__(self):
        self.dispatched = None

    async def dispatch(self, item):
        self.dispatched = item.get("content")
        return True, DispatchOutcome.OK


async def test_process_text_generates_and_prepends_tags(monkeypatch):
    """text 无标签 → 生成标签 + #前缀拼接（对齐老 dispatcher process_text）"""

    async def fake_gen(http, content, key):
        return ["读书", "效率"]

    monkeypatch.setattr("inboxserver.workers.runner.generate_smart_tags", fake_gen)

    flomo = FakeFlomo()
    process = _make_process_text(http=None, flomo=flomo, llm_key="k")
    await process({"content": "原内容"})

    assert flomo.dispatched == "#读书 #效率 原内容"


async def test_process_text_glm_empty_no_prefix(monkeypatch):
    """GLM 返回空 → 不加前缀，原样 dispatch（不阻塞）"""

    async def fake_gen(http, content, key):
        return []

    monkeypatch.setattr("inboxserver.workers.runner.generate_smart_tags", fake_gen)

    flomo = FakeFlomo()
    process = _make_process_text(http=None, flomo=flomo, llm_key="k")
    await process({"content": "原内容"})

    assert flomo.dispatched == "原内容"


async def test_process_text_keeps_existing_tags():
    """已有 tags 的 item 不再生成（短路）—— text 通常无 tags，但保证幂等"""

    flomo = FakeFlomo()
    process = _make_process_text(http=None, flomo=flomo, llm_key="k")
    # 带 tags 的 item：process 不改 content（无 GLM 调用），直接 dispatch
    await process({"content": "原内容", "tags": ["已存在"]})

    assert flomo.dispatched == "原内容"
