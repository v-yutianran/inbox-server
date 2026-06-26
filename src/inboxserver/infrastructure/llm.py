"""GLM 智能标签调用（IO 层）。

prompt 构建与响应解析在 domain/policy/smart_tags（纯函数）——本层只负责 HTTP。
失败/无 key/无内容 → 返回 []（不阻塞主流程）。
"""

from __future__ import annotations

import httpx

from inboxserver.domain.policy.smart_tags import build_glm_prompt, parse_glm_response

GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions"


async def generate_smart_tags(
    http: httpx.AsyncClient, content: str, api_key: str, model: str = "glm-4-flash"
) -> list[str]:
    """调 GLM 生成智能标签。任何异常返回 []（附加能力，不阻塞分发）。"""
    if not api_key or not content:
        return []
    try:
        resp = await http.post(
            GLM_ENDPOINT,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [{"role": "user", "content": build_glm_prompt(content)}],
                "max_tokens": 60,
            },
        )
        data = resp.json()
        text = data["choices"][0]["message"]["content"]
        return parse_glm_response(text)
    except Exception:
        return []
