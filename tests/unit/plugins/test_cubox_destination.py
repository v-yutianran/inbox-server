"""Cubox 目的地测试（respx mock）：200→OK / -3030→QUOTA / 其他→FAIL / 非JSON兜底。"""

import httpx
import pytest
import respx

from inboxserver.plugins.contracts import DispatchOutcome
from inboxserver.plugins.destinations.cubox import CuboxDestination

API = "https://cubox.test/api/save"


@pytest.fixture
async def cubox():
    client = httpx.AsyncClient()
    yield CuboxDestination({"api_url": API}, client)
    await client.aclose()


@respx.mock
async def test_cubox_success(cubox):
    respx.post(API).mock(return_value=httpx.Response(200, json={"code": 200}))
    ok, outcome = await cubox.dispatch({"url": "https://x.com", "title": "X", "tags": ["a"]})
    assert ok is True and outcome is DispatchOutcome.OK


@respx.mock
async def test_cubox_quota_minus_3030(cubox):
    respx.post(API).mock(return_value=httpx.Response(200, json={"code": -3030}))
    ok, outcome = await cubox.dispatch({"url": "https://x.com"})
    assert ok is False and outcome is DispatchOutcome.QUOTA


@respx.mock
async def test_cubox_other_code_fail(cubox):
    respx.post(API).mock(return_value=httpx.Response(200, json={"code": 500}))
    ok, outcome = await cubox.dispatch({"url": "https://x.com"})
    assert ok is False and outcome is DispatchOutcome.FAIL


@respx.mock
async def test_cubox_non_json_fallback(cubox):
    """非 JSON 响应兜底用 HTTP status。"""
    respx.post(API).mock(return_value=httpx.Response(200, text="OK"))
    ok, outcome = await cubox.dispatch({"url": "https://x.com"})
    assert ok is True and outcome is DispatchOutcome.OK
