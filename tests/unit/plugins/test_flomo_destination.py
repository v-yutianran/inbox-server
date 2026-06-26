"""flomo 目的地测试（respx mock）：code0→OK / 其他→FAIL。"""

import httpx
import pytest
import respx

from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.plugins.destinations.flomo import FlomoDestination

WEBHOOK = "https://flomo.test/webhook"


@pytest.fixture
async def flomo():
    client = httpx.AsyncClient()
    yield FlomoDestination({"webhook": WEBHOOK}, client)
    await client.aclose()


@respx.mock
async def test_flomo_success(flomo):
    respx.post(WEBHOOK).mock(return_value=httpx.Response(200, json={"code": 0}))
    ok, outcome = await flomo.dispatch({"content": "#读书 hello"})
    assert ok is True and outcome is DispatchOutcome.OK


@respx.mock
async def test_flomo_fail(flomo):
    respx.post(WEBHOOK).mock(return_value=httpx.Response(200, json={"code": 1}))
    ok, outcome = await flomo.dispatch({"content": "hi"})
    assert ok is False and outcome is DispatchOutcome.FAIL
