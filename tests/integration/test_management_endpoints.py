"""管理端点集成测试：/queue、/queue/dlq、/channels、/login/*。

httpx.AsyncClient + ASGITransport 走完整 HTTP 路径，dependency_overrides 注入
fake_redis + sqlite 内存 session（复用 conftest fixture），零外部依赖。
"""

from __future__ import annotations

import httpx
import pytest

from inboxserver.api.app import create_app
from inboxserver.api.deps import get_http, get_redis, get_session
from inboxserver.config.settings import settings
from inboxserver.domain.models import ItemKind
from inboxserver.infrastructure.operations.heartbeat import write_worker_heartbeat
from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
from inboxserver.infrastructure.persistence.repositories.article_archive_event import (
    ArticleArchiveEventRepo,
)
from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo
from inboxserver.infrastructure.persistence.repositories.sync_job import SyncJobRepo
from inboxserver.infrastructure.queue.repository import RedisQueueRepository


def _dep(value):
    """dependency_overrides 工厂：把固定值包成 yield 依赖（复刻 get_redis/get_session 形态）。"""

    async def _gen():
        yield value

    return _gen


@pytest.fixture(autouse=True)
def _open_auth(monkeypatch):
    """测试默认开放鉴权（避免真实 .env 的 ADMIN_API_KEY 泄漏进测试导致端点全 401）。

    鉴权专门测试 test_require_api_key_when_configured 自行 monkeypatch 覆盖此值。
    """
    monkeypatch.setattr(settings, "admin_api_key", "")


async def test_queue_returns_counts(fake_redis, db_session):
    """GET /queue 返回 link/text/file/article 队列的 pending/dlq/done 计数。"""
    repo = RedisQueueRepository(fake_redis)
    await repo.enqueue(ItemKind.LINK, {"url": "https://a"})
    await repo.enqueue(ItemKind.LINK, {"url": "https://b"})
    await repo.move_to_dlq(ItemKind.TEXT, {"text": "bad"})
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/queue")
    q = r.json()["queues"]
    assert r.status_code == 200
    assert q["link"]["pending"] == 2
    assert q["text"]["dlq"] == 1
    assert set(q.keys()) == {"link", "text", "file", "article"}
    assert q["article"] == {"pending": 0, "dlq": 0, "done": 0}


async def test_queue_dlq_returns_items(fake_redis, db_session):
    """GET /queue/dlq 返回死信内容（不消费）。"""
    repo = RedisQueueRepository(fake_redis)
    await repo.move_to_dlq(ItemKind.LINK, {"url": "https://x", "title": "t"})
    await repo.move_to_dlq(
        ItemKind.ARTICLE,
        {"url": "https://article.example/x", "title": "article", "retry": 3},
    )
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/queue/dlq")
    body = r.json()
    assert r.status_code == 200
    assert body["counts"]["link"] == 1
    assert body["dlq"]["link"][0]["url"] == "https://x"
    assert body["counts"]["article"] == 1
    assert body["dlq"]["article"][0]["retry"] == 3


async def test_channels_redacts_secrets(monkeypatch, tmp_path, fake_redis, db_session):
    """GET /channels 严格脱敏：不暴露 token/credentials/llm 明文。"""
    yaml = tmp_path / "channels.yaml"
    yaml.write_text(
        """
sources:
  telegram:
    enabled: true
    config: {bot_token: "${TG_TOKEN}", credential_name: "tg_creds"}
destinations:
  cubox:
    enabled: true
    item_kind: link
    config: {api_url: "${CUBOX}"}
credentials:
  tg_creds: {platform: telegram, kind: token, vault_id: "tg_main"}
llm:
  glm_api_key: "${GLM}"
"""
    )
    monkeypatch.setenv("TG_TOKEN", "secret-bot-token-123")
    monkeypatch.setenv("INBOX_CHANNELS", str(yaml))
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/channels")
    body = r.json()
    assert r.status_code == 200
    assert body["sources"]["telegram"]["enabled"] is True
    assert body["sources"]["telegram"]["credential_name"] == "tg_creds"
    assert body["destinations"]["cubox"]["item_kind"] == "link"
    # 脱敏：明文凭据/key 不出现在响应
    assert "secret-bot-token-123" not in r.text
    assert "credentials" not in body
    assert "llm" not in body


async def test_login_cookie_write_and_status(fake_redis, db_session):
    """POST /login/zhihu/cookie 加密落库（name=zhihu_creds）；GET status 无 session → none。"""
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/login/zhihu/cookie", json={"z_c0": "fake-zc0"})
        assert r.status_code == 200
        assert r.json()["vault_id"] == "zhihu_creds"
        # 验证加密落库：能解密回原值
        enc = await CredentialRepo(db_session).get_encrypted("zhihu_creds")
        assert enc is not None
        assert CredentialVault().decrypt(enc) == {"z_c0": "fake-zc0"}
        # GET status：无 login_session 记录 → none
        r = await c.get("/login/zhihu/status")
        assert r.status_code == 200
        assert r.json()["session_status"] == "none"


async def test_login_validation_errors(fake_redis, db_session):
    """POST /login 校验：不支持平台 → 400；缺必填字段 → 400。"""
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/login/unknown/cookie", json={"x": "y"})
        assert r.status_code == 400
        r = await c.post("/login/zhihu/cookie", json={})
        assert r.status_code == 400


async def test_require_api_key_when_configured(monkeypatch, fake_redis, db_session):
    """配置 ADMIN_API_KEY 后：无 key/错 key → 401；对 key → 200。"""
    monkeypatch.setattr(settings, "admin_api_key", "secret-key")
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.get("/queue")).status_code == 401
        assert (await c.get("/queue", headers={"X-API-Key": "wrong"})).status_code == 401
        assert (await c.get("/queue", headers={"X-API-Key": "secret-key"})).status_code == 200


async def test_manual_sync_persists_completed_run(
    monkeypatch, tmp_path, fake_redis, db_session
):
    """POST /sync 保持响应契约，并通过公开历史 Repository 留下 manual 记录。"""
    yaml = tmp_path / "channels.yaml"
    yaml.write_text("sources: {}\ndestinations: {}\n")
    monkeypatch.setenv("INBOX_CHANNELS", str(yaml))
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient() as outbound:
        app.dependency_overrides[get_http] = _dep(outbound)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://t"
        ) as client:
            response = await client.post("/sync")

    jobs = await SyncJobRepo(db_session).list_recent(limit=5)
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "results": {}}
    assert len(jobs) == 1
    assert jobs[0].triggered_by == "manual"
    assert jobs[0].status == "done"


async def test_operations_overview_returns_safe_aggregated_state(
    monkeypatch, tmp_path, fake_redis, db_session
):
    yaml = tmp_path / "channels.yaml"
    yaml.write_text(
        "sources:\n  telegram: {enabled: false, kind: api}\n"
        "destinations:\n  cubox: {enabled: false, item_kind: link}\n"
    )
    monkeypatch.setenv("INBOX_CHANNELS", str(yaml))
    await RedisQueueRepository(fake_redis).enqueue(ItemKind.LINK, {"url": "https://a"})
    await write_worker_heartbeat(fake_redis)
    jobs = SyncJobRepo(db_session)
    job_id = await jobs.start("manual")
    await jobs.mark_done(job_id, {"telegram": {"enqueued": 1}})
    await ArticleArchiveEventRepo(db_session).record(
        source_url="https://example.com/article",
        url_fingerprint="0123456789",
        title="文章",
        status="committed",
        reason=None,
        filename="20260719-文章.md",
    )

    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    ) as client:
        response = await client.get("/api/operations/overview")

    body = response.json()
    assert response.status_code == 200
    assert body["server"] == {"online": True}
    assert body["worker"]["online"] is True
    assert body["scheduler"]["interval_seconds"] == 600
    assert body["queues"]["link"]["pending"] == 1
    assert body["channels"]["sources"]["telegram"]["enabled"] is False
    assert body["sync_jobs"][0]["triggered_by"] == "manual"
    assert body["article_events"][0]["status"] == "committed"
    assert "credentials" not in response.text
    assert "api_key" not in response.text.lower()


async def test_operations_overview_requires_api_key(
    monkeypatch, fake_redis, db_session
):
    monkeypatch.setattr(settings, "admin_api_key", "secret-key")
    app = create_app()
    app.dependency_overrides[get_redis] = _dep(fake_redis)
    app.dependency_overrides[get_session] = _dep(db_session)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    ) as client:
        response = await client.get("/api/operations/overview")

    assert response.status_code == 401
