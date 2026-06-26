"""httpx AsyncClient 工厂（目的地 API / LLM 调用共用）。"""

from __future__ import annotations

import httpx


def make_http_client(timeout: float = 20.0) -> httpx.AsyncClient:
    """创建共享 httpx.AsyncClient（连接池复用）。"""
    return httpx.AsyncClient(timeout=timeout)
