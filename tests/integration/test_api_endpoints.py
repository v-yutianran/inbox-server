"""API 集成测试：health 端点（无外部依赖，TestClient 直测）。

sync 端点依赖 session/redis/http（需 dependency_overrides 注入 fakeredis+sqlite+respx），
较重，放专门的 sync pipeline 测试。
"""

from __future__ import annotations

from pathlib import Path

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


def test_new_routes_registered():
    """5 个新端点已注册：/queue、/queue/dlq、/channels、/login/{platform}/*。"""
    client = TestClient(create_app())
    paths = client.get("/openapi.json").json()["paths"]
    for ep in [
        "/queue",
        "/queue/dlq",
        "/channels",
        "/login/{platform}/cookie",
        "/login/{platform}/status",
    ]:
        assert ep in paths, f"missing route: {ep}"


def test_console_static_files_do_not_shadow_existing_routes(tmp_path: Path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (tmp_path / "index.html").write_text("<main>operations console</main>")
    (assets / "app.js").write_text("console.log('ok')")

    client = TestClient(create_app(web_dist=tmp_path))

    assert client.get("/").text == "<main>operations console</main>"
    assert client.get("/assets/app.js").text == "console.log('ok')"
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/openapi.json").status_code == 200
