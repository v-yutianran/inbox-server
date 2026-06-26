# inbox-server 镜像：uv + playwright chromium（headed）+ xvfb
FROM python:3.12-slim

# 系统依赖：xvfb（headed 浏览器需 X display）+ curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl xvfb \
    && rm -rf /var/lib/apt/lists/*

# uv（astral 官方镜像二进制）
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# 依赖先装（利用 docker layer 缓存）
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev

# playwright chromium（headed；容器内 --no-sandbox 由应用层 args 处理）
RUN uv run playwright install --with-deps chromium

COPY . .
ENV INBOX_CHANNELS=/app/channels.yaml
ENV PYTHONUNBUFFERED=1

EXPOSE 8000
# 默认 server 入口；worker 服务在 docker-compose 用 xvfb-run 覆盖 command
CMD ["uv", "run", "uvicorn", "inboxserver.main:app", "--host", "0.0.0.0", "--port", "8000"]
