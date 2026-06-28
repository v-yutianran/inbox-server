# inbox-server

> 商业化私有化部署的收件箱分发服务：统一收集（滴答清单 / Telegram / 知乎 / inoreader / YouTube / B站）→ 入队 → 限速分发（Cubox / flomo / 坚果云）。

## 架构

四个服务（`docker-compose.yml`）：

| 服务 | 职责 |
|------|------|
| **postgres** | 持久化（凭据加密 / 登录态 / 增量基线 / sync job） |
| **redis** | 队列 + 限速令牌 + 去重指纹 |
| **server** | FastAPI：API 源收集（telegram/dida）+ 管理端点；启动 `alembic upgrade head` 建表 |
| **worker** | 消费循环（限速/去重/重试/DLQ）+ browser 源收集（headed chromium + Xvfb：知乎/inoreader/B站/油管） |

数据流：`Sources(telegram/dida/知乎/...) → server.collect → Redis 队列 → worker.consume → Destinations(Cubox/flomo/坚果云)`；browser 源由 worker 定时 collect（server 无 DISPLAY）。

## 快速启动

```bash
cp .env.example .env                      # 填部署密钥 + 业务凭据
cp channels.yaml.example channels.yaml    # 启用 source/destination
docker compose up -d                       # server 启动自动 alembic 建表
```

## 配置

### `.env`（`INBOX_` 前缀，见 `.env.example`）

| 变量 | 说明 |
|------|------|
| `INBOX_MASTER_KEY` | 凭据加密主密钥（`openssl rand -base64 32` 生成，**必填**） |
| `INBOX_ADMIN_API_KEY` | API 鉴权 key（请求头 `X-API-Key`，自定义） |
| `INBOX_REDIS_URL` / `INBOX_DATABASE_URL` | redis / postgres 连接 |
| `TELEGRAM_BOT_TOKEN` / `DIDA365_ACCESS_TOKEN` | source 凭据 |
| `CUBOX_API_KEY` / `FLOMO_WEBHOOK` / `JIANGUOYUN_USER` / `JIANGUOYUN_PASS` | destination 凭据 |
| `Z_AI_API_KEY` | GLM 智能标签 key（`channels.yaml` 的 `llm.glm_api_key` 引用） |
| `INBOX_SMTP_*` / `INBOX_EMAIL_*` | 邮件通知（可选；`settings.py` 支持，`.env` 覆盖，见下方凭据获取） |

### `channels.yaml`（渠道编排）

声明启用的 source/destination + 参数 + 凭据引用。`${ENV}` 从环境变量插值（凭据不落 yaml 明文）。详见 `channels.yaml.example`。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 存活（无需鉴权） |
| GET | `/readyz` | 就绪 |
| POST | `/sync` | 触发一次收集（API 源）→ 入队 |
| GET | `/queue` | 三类队列计数（pending/dlq/done） |
| GET | `/queue/dlq` | 死信内容 |
| GET | `/channels` | 渠道列表（脱敏，不透出 token） |
| POST | `/login/{platform}/cookie` | 写入 browser 源登录凭据（Fernet 加密落库） |
| GET | `/login/{platform}/status` | 登录态状态 |

除 `/healthz` 外均需请求头 `X-API-Key: $INBOX_ADMIN_API_KEY`。

## 测试

```bash
uv run ruff check src/inboxserver tests scripts        # lint
uv run pytest tests/unit tests/integration             # 单元 + 集成（默认跳过 e2e）
uv run pytest -m e2e                                   # e2e（需真实凭据 + chromium）
uv run mypy src/inboxserver --ignore-missing-imports   # 类型检查
```

## 凭据获取（需用户配置）

代码链路已就绪，缺的是真实凭据值，需手动获取并填入：

| 凭据 | 填入位置 | 获取方式 |
|------|---------|---------|
| **网易 163 SMTP 授权码** | `.env` `INBOX_SMTP_PASS`（+ `INBOX_SMTP_USER` 发件 163 邮箱、`INBOX_SMTP_HOST=smtp.163.com`） | 网易 163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 生成授权码（**非登录密码**） |
| **Telegram chat_id** | `channels.yaml` `notification.telegram_chat_id` | Telegram 转发任意消息给 `@userinfobot`，回复的数字即 chat_id |
| **browser 源登录凭据** | `POST /login/{platform}/cookie` | 知乎 `z_c0` / B站 `SESSDATA` / inoreader session / YouTube cookie——浏览器登录后从 DevTools 取，POST 写入（加密落库） |

> SMTP / chat_id 缺失不阻塞：邮件走 `LogNotifier` 兜底、Telegram 通道跳过。
> browser 源需先在 `channels.yaml` 启用 + 配 `credential_name`，再 POST 登录凭据。

## 开发

- Python ≥3.12，uv 管理依赖（`uv sync --dev`）
- DDD 分层：`domain/policy`（纯函数）/ `infrastructure` / `api` / `workers` / `plugins`
- spec-driven：`openspec/`（proposal/design/tasks → archive）
- 进度路线：`roadmap.md`；协作规范：`CLAUDE.md`
- Git 工作流：feature 分支 + PR，禁止直接改 `main`
