"""邮件通知器（agently-cli，复刻 inbox_dispatcher.send_email_report）。

agently-cli message +send 两阶段确认（首次返回 confirmation_token，二次带 token 真发）。
容器需装 node + agently-cli（Dockerfile 侧）。失败不抛（通知是附加通道）。
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess

from inboxserver.config.settings import settings


class EmailNotifier:
    """agently-cli 发邮件到 QQ 邮箱（两阶段确认）。"""

    def __init__(self):
        self._agently = settings.agently_cli_path
        self._to = settings.email_to

    async def notify(self, message: str, subject: str = "[收件箱同步]") -> None:
        """agently-cli 两阶段发送。失败静默（附加通道，不阻塞主流程）。"""
        env = os.environ.copy()
        # agently-cli shebang 依赖 node；补 node 路径防定时任务窄 PATH
        env["PATH"] = os.pathsep.join(
            ["/opt/homebrew/bin", "/Applications/ServBay/script/alias", env.get("PATH", "")]
        )
        base = [
            self._agently,
            "message",
            "+send",
            "--to",
            self._to,
            "--subject",
            subject,
            "--body",
            message,
            "--body-format",
            "plain",
        ]
        try:
            # 阶段1：取 confirmation_token（不真发）
            p1 = await asyncio.to_thread(
                subprocess.run, base, capture_output=True, text=True, timeout=60, env=env
            )
            if p1.returncode != 0:
                return
            token = (json.loads(p1.stdout).get("data") or {}).get("confirmation_token")
            if not token:
                return
            # 阶段2：带 token 真发
            await asyncio.to_thread(
                subprocess.run,
                base + ["--confirmation-token", token],
                capture_output=True,
                text=True,
                timeout=60,
                env=env,
            )
        except Exception:
            pass  # 通知失败绝不影响主流程
