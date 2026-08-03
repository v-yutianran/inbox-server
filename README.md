# inbox-server

> 商业化私有化部署的收件箱分发服务：统一收集（滴答清单 / Telegram / 知乎 / inoreader / YouTube / B站）→ 入队 → 限速分发（Cubox / flomo / 坚果云）。

## 架构

当前生产环境采用 Cloudflare + Sealos 混合架构，不依赖本机 Docker 服务：

| 服务 | 部署 | 职责 |
|------|------|------|
| **console** | Cloudflare Pages（`apps/console`） | Vite / React 运维控制台 |
| **server** | Cloudflare Workers（`apps/api`） | Hono API、D1 运维快照与 Cloudflare Queues 任务发布 |
| **worker** | Sealos StatefulSet（`apps/worker`） | headed Chromium 浏览器采集、队列消费与文章归档 |
| **sidecars** | Sealos（`deploy/sealos`） | mihomo 转发与 WARP 受控出站 |
| **legacy** | 保留的 Docker Compose 资产 | 只作为授权回滚窗口内的旧资产，不是当前生产依赖 |

Cloudflare API 负责运维控制面、D1 状态与 Queue 发布；Sealos Worker 负责需要浏览器和持久状态的执行面。生产运维入口、健康检查、重放、保留和发布回滚流程见 [`docs/production-operations-runbook.md`](docs/production-operations-runbook.md)。

## Legacy Python 本地开发

```bash
cp .env.example .env                      # 填部署密钥 + 业务凭据
cp channels.yaml.example channels.yaml    # 启用 source/destination
docker compose up -d                       # server 启动自动 alembic 建表
```

## 发布与回滚

```zsh
npm ci
npm run release -- plan --manifest <release-manifest.json> --action apply
npm run release -- apply --manifest <release-manifest.json> --dry-run
npm run release -- apply --manifest <release-manifest.json> --confirm <planHash> --evidence <new-evidence.json>
```

根目录不提供绕过发布计划的 API/Console 手工部署快捷命令。release manifest 必须固定源码提交、Cloudflare version/deployment、D1 migration、Sealos revision 和三容器镜像 digest；实际执行还必须取得生产部署授权并确认同一 `planHash`。API 管理密钥通过 Wrangler Secret `ADMIN_API_KEY` 配置，不写入仓库、manifest 或发布证据。

详细的 dry-run、回滚、稳定窗口和禁止事项见[生产运维就绪手册](docs/production-operations-runbook.md)。

### 手工验收清单

- [ ] 打开 Pages 预览 URL，确认标题、解锁表单与响应式布局正常，无资源加载失败
- [ ] 分别访问 Worker `/healthz` 与 `/readyz`，确认返回 200
- [ ] 使用真实 `ADMIN_API_KEY` 解锁 Console，确认请求只发往预览部署指定的 HTTPS Worker
- [ ] 确认 `/api/operations/overview` 返回 200，错误 Key 返回 401，概览与旧服务快照一致
- [ ] Queue 消费者启用前确认手动同步返回 503；启用后再验证任务发布、消费、ack 与刷新恢复
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
