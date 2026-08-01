# inbox-server

> 商业化私有化部署的收件箱分发服务：统一收集（滴答清单 / Telegram / 知乎 / inoreader / YouTube / B站）→ 入队 → 限速分发（Cubox / flomo / 坚果云）。

## 架构

当前按 OpenSpec 分阶段迁移，Cloudflare 预览与旧生产链路并行：

| 服务 | 部署 | 职责 |
|------|------|------|
| **console** | Cloudflare Pages（`apps/console`） | Vite / React 运维控制台 |
| **server** | Cloudflare Workers（`apps/api`） | Hono API；当前预览阶段提供 `/healthz` 与 `/readyz` |
| **worker** | Docker（`apps/worker`） | headed Chromium / Xvfb 浏览器采集与队列消费 |
| **legacy** | Docker Compose | FastAPI / PostgreSQL / Redis 生产链路，在数据与接口迁移完成前继续运行 |

Cloudflare API 的业务端点、D1 与 Queues 仍按 `openspec/changes/migrate-to-typescript-cloudflare/tasks.md` 逐项迁移；预览环境不会替代或停止旧生产服务。

## 快速启动

```bash
cp .env.example .env                      # 填部署密钥 + 业务凭据
cp channels.yaml.example channels.yaml    # 启用 source/destination
docker compose up -d                       # server 启动自动 alembic 建表
```

## Cloudflare 预览部署

```bash
npm ci
npm run api:deploy:dry-run
npm run api:deploy
npm run console:deploy:preview -- --api-url https://<worker>.workers.dev --dry-run
npm run console:deploy:preview -- --api-url https://<worker>.workers.dev
```

Console 部署脚本只允许在干净的非 `main` 分支执行，并把当前提交与功能分支写入 Pages 预览部署元数据。首次部署前需创建 `inbox-server-console` Pages 项目；API 管理密钥通过 Wrangler Secret `ADMIN_API_KEY` 配置，不写入仓库。

### 手工验收清单

- [ ] 打开 Pages 预览 URL，确认标题、解锁表单与响应式布局正常，无资源加载失败
- [ ] 分别访问 Worker `/healthz` 与 `/readyz`，确认返回 200
- [ ] 使用真实 `ADMIN_API_KEY` 解锁 Console，确认请求只发往预览部署指定的 HTTPS Worker
- [ ] 完成 OpenSpec 3.5 的业务端点迁移后，验证概览加载、手动同步、错误 Key 提示与刷新恢复；迁移前 `/api/operations/overview` 返回 404 是预期边界，不得据此切换生产
- [ ] 生产切换前完成 D1、Queues、Cron、回滚和旧服务下线门禁

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
- TypeScript ≥5.9，npm workspace 管理 `apps/console`、`apps/api` 与 `apps/worker`
- DDD 分层：`domain/policy`（纯函数）/ `infrastructure` / `api` / `workers` / `plugins`
- spec-driven：`openspec/`（proposal/design/tasks → archive）
- 进度路线：`roadmap.md`；协作规范：`CLAUDE.md`
- Git 工作流：feature 分支 + PR，禁止直接改 `main`
