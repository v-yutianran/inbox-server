# 用 playwright 官方镜像（已预装 chromium + 全套系统依赖），避免 install 网络/超时卡住
FROM mcr.microsoft.com/playwright/python:1.60

# xvfb（headed 必需）+ curl
RUN apt-get update && apt-get install -y --no-install-recommends xvfb curl \
    && rm -rf /var/lib/apt/lists/*

# uv（astral 官方镜像二进制）
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

# 依赖先装（利用 docker layer 缓存）
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev
# 注：chromium 由基镜像预装（PLAYWRIGHT_BROWSERS_PATH 已设），无需 playwright install

COPY . .
ENV INBOX_CHANNELS=/app/channels.yaml
ENV PYTHONUNBUFFERED=1

EXPOSE 8000
# 默认 server 入口；worker 服务在 docker-compose 用 xvfb-run 覆盖 command
CMD ["uv", "run", "uvicorn", "inboxserver.main:app", "--host", "0.0.0.0", "--port", "8000"]
