"""browser_collector 的 X source 编排测试。"""

from __future__ import annotations

from dataclasses import dataclass

from inboxserver.config.channels import ChannelEntry, ChannelsConfig
from inboxserver.infrastructure.collectors import browser_collector
from inboxserver.plugins.contracts import CollectResult


@dataclass
class _Deps:
    sm: object = object()
    pool: object = object()
    baseline_repo: object = object()
    llm_key: str = ""


async def test_collect_browser_sources_runs_x_source(monkeypatch):
    seen_configs = {}

    async def fake_create_browser_deps(channels, session):
        return _Deps()

    class FakeXSource:
        def __init__(self, configs, *args):
            seen_configs.update(configs)

        async def collect(self):
            return {
                "x_bookmarks": CollectResult(
                    enqueued={"link": 1},
                    meta={"platform": "x_bookmarks"},
                )
            }

    monkeypatch.setattr(browser_collector, "_create_browser_deps", fake_create_browser_deps)
    monkeypatch.setattr("inboxserver.plugins.sources.x.XPlaywrightSource", FakeXSource)
    channels = ChannelsConfig(
        sources={
            "x_bookmarks": ChannelEntry(
                enabled=True,
                config={"credential_name": "x_creds"},
            )
        }
    )

    result = await browser_collector.collect_browser_sources(channels, None, None, None)

    assert seen_configs == {"x_bookmarks": {"credential_name": "x_creds"}}
    assert result["x_bookmarks"]["enqueued"] == {"link": 1}
