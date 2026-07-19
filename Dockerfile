FROM node:22.17.0-bookworm-slim AS article-node

WORKDIR /node-app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22.17.0-bookworm-slim AS web-build

WORKDIR /web-build
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web ./web
RUN pnpm build:web

# 用 playwright 官方镜像（已预装 chromium + 全套系统依赖），避免 install 网络/超时卡住
# tag 格式 v{version}（不是 1.60，是 v1.60.0）
FROM mcr.microsoft.com/playwright/python:v1.60.0

# xvfb（headed 必需）+ curl
RUN apt-get update && apt-get install -y --no-install-recommends xvfb curl \
    && rm -rf /var/lib/apt/lists/*

# uv（astral 官方镜像二进制）
COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /bin/uv

WORKDIR /app

# 固定 Node.js + pnpm 锁定的 Defuddle/Eta 生产依赖；运行时不依赖宿主机全局 npm。
COPY --from=article-node /usr/local/bin/node /usr/local/bin/node
COPY --from=article-node /node-app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# 依赖先装（利用 docker layer 缓存）
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
# uv sync 用清华 pypi 镜像（国内快，不依赖 proxy；buildkit RUN 不自动走 config.json proxies）
ENV UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN uv sync --frozen --no-dev
# 注：chromium 由基镜像预装（PLAYWRIGHT_BROWSERS_PATH 已设），无需 playwright install

COPY . .
COPY --from=web-build /web-build/web/dist ./web/dist
RUN chmod 0555 /app/scripts/github-askpass.sh
RUN node --version && node -e "Promise.all([import('defuddle/node'), import('eta')])"
ENV INBOX_CHANNELS=/app/channels.yaml
ENV PYTHONUNBUFFERED=1

EXPOSE 8000
# 默认 server 入口；worker 服务在 docker-compose 用 xvfb-run 覆盖 command
CMD ["uv", "run", "uvicorn", "inboxserver.main:app", "--host", "0.0.0.0", "--port", "8000"]
