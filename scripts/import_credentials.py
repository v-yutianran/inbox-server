"""从 playwright-cli default session 提取登录态 → 写入 inbox-server CredentialVault。

用法（inbox-server 目录）：uv run python scripts/import_credentials.py
前提：playwright-cli default session 已登录知乎/B站/inoreader/YouTube/X。

提取：
  zhihu z_c0 / bilibili SESSDATA（单 cookie，LoginStrategy 注入时构造完整 cookie）
  inoreader/youtube/X 全 storage_state（多 cookie，LoginStrategy 直接用）
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile


def export_state() -> dict:
    """playwright-cli state-save → 全 storage_state（用 state-save 避免 cookie-get 编码坑）。"""
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        path = f.name
    try:
        subprocess.run(["playwright-cli", "state-save", path], check=True, capture_output=True)
        return json.load(open(path))
    finally:
        os.unlink(path)


def extract_credentials(state: dict) -> dict[str, dict]:
    """从 state.cookies 提取各平台凭证。"""
    cookies = state.get("cookies", [])
    creds: dict[str, dict] = {}

    zc0 = next(
        (c for c in cookies if c.get("name") == "z_c0" and "zhihu.com" in c.get("domain", "")),
        None,
    )
    if zc0:
        creds["zhihu_creds"] = {
            "platform": "zhihu",
            "kind": "cookie",
            "payload": {"z_c0": zc0["value"]},
        }

    sd = next(
        (
            c
            for c in cookies
            if c.get("name") == "SESSDATA" and "bilibili.com" in c.get("domain", "")
        ),
        None,
    )
    if sd:
        creds["bili_creds"] = {
            "platform": "bilibili",
            "kind": "cookie",
            "payload": {"sessdata": sd["value"]},
        }

    ino = [c for c in cookies if "inoreader.com" in c.get("domain", "")]
    if ino:
        creds["inoreader_creds"] = {
            "platform": "inoreader",
            "kind": "session",
            "payload": {"storage_state": {"cookies": ino, "origins": state.get("origins", [])}},
        }

    yt = [
        c
        for c in cookies
        if "youtube.com" in c.get("domain", "") or "google.com" in c.get("domain", "")
    ]
    if yt:
        creds["youtube_creds"] = {
            "platform": "youtube",
            "kind": "session",
            "payload": {"storage_state": {"cookies": yt, "origins": []}},
        }

    x_cookies = [
        c
        for c in cookies
        if "x.com" in c.get("domain", "") or "twitter.com" in c.get("domain", "")
    ]
    if x_cookies:
        x_origins = [
            o
            for o in state.get("origins", [])
            if "x.com" in o.get("origin", "") or "twitter.com" in o.get("origin", "")
        ]
        creds["x_creds"] = {
            "platform": "x",
            "kind": "session",
            "payload": {"storage_state": {"cookies": x_cookies, "origins": x_origins}},
        }

    return creds


async def write_vault(creds: dict[str, dict]) -> None:
    """建表（若未迁移）+ 写入 CredentialVault。"""
    from inboxserver.infrastructure.persistence import models  # noqa: F401
    from inboxserver.infrastructure.persistence.base import Base
    from inboxserver.infrastructure.persistence.crypto.vault import CredentialVault
    from inboxserver.infrastructure.persistence.db import async_session_factory, engine
    from inboxserver.infrastructure.persistence.repositories.credential import CredentialRepo

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    vault = CredentialVault()
    async with async_session_factory() as session:
        repo = CredentialRepo(session)
        for name, info in creds.items():
            await repo.upsert(name, info["platform"], info["kind"], vault.encrypt(info["payload"]))
            print(f"  ✅ {name}（{info['platform']} / {info['kind']}）")


async def main() -> None:
    print("→ 从 playwright-cli default session 提取登录态...")
    state = export_state()
    creds = extract_credentials(state)
    if not creds:
        print(
            "⚠️ 未提取到任何平台凭证。请确认 default session 已登录 "
            "知乎/B站/inoreader/YouTube/X（playwright-cli open 登录后持久化）。"
        )
        return
    print(f"→ 提取到 {len(creds)} 个平台: {list(creds)}")
    print("→ 写入 CredentialVault...")
    await write_vault(creds)
    print("✅ 完成。浏览器源现在可用这些凭证（channels.yaml 引用 credential_name）。")


if __name__ == "__main__":
    asyncio.run(main())
