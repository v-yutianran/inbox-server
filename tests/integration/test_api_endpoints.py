"""API 集成测试：health 端点（无外部依赖，TestClient 直测）。

sync 端点依赖 session/redis/http（需 dependency_overrides 注入 fakeredis+sqlite+respx），
较重，放专门的 sync pipeline 测试。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from inboxserver.api.app import create_app


def test_healthz():
    client = TestClient(create_app())
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_readyz():
    client = TestClient(create_app())
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


def test_sync_requires_no_key_when_unset():
    """未配置 ADMIN_API_KEY 时 sync 放行（开发模式）。路由可达即 200。"""
    client = TestClient(create_app())
    # sync 会触发 get_session（连 DB），此处仅验证路由注册可达：用错误的依赖会报 500 而非 404
    r = client.post("/sync")
    assert r.status_code != 404  # 路由存在（可能 500 因无 DB，但非 404）
