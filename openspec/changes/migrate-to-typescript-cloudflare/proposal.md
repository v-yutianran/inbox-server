## Why

当前系统的 console 已使用 TypeScript，但 server 与 worker 仍由 Python、PostgreSQL、Redis 和宿主机 Docker Compose 共同承载，部署、类型契约和运维边界分散。参考 `gtd-demo` 的 Hono、Drizzle、D1 与 Cloudflare 交付方式后，需要在不牺牲 headed Playwright 采集能力的前提下统一 TypeScript 开发体验，并把长驻浏览器任务保留在独立 Docker worker 中。

## What Changes

- 建立 npm TypeScript 工作区，按 `apps/console`、`apps/api`、`apps/worker` 与 `packages/domain` 划分可独立部署的应用和纯领域逻辑。
- 将 console 作为静态 Web 应用部署到 Cloudflare，将 server 迁移为 Hono Worker，并用 Drizzle 管理 D1 持久化模型。
- 使用 Cloudflare Queues 建立 API 与外部 worker 的任务契约；Docker worker 通过受认证的拉取接口消费任务、续租或确认结果。
- 将必须运行 headed Chromium 的 browser sources 保留在 TypeScript Docker worker 中，继续使用 Xvfb、持久化浏览器登录态、心跳健康检查和优雅退出，并以 Sealos 北京区 `bja`、工作区 `ns-tbs948af` 为目标部署环境。
- 迁移期间保留现有 Python 服务作为可回滚基线；按纵向切片逐项完成契约测试、数据迁移验证、双跑去重和功能对等检查，未满足切换门槛前不停止现网服务。
- **BREAKING**：完成切换后，server 的运行环境从 FastAPI/PostgreSQL/Redis/Nginx 改为 Cloudflare Workers/D1/Queues，worker 的队列接入和部署配置随之调整；对外 API 路径和业务语义保持兼容。

## Capabilities

### New Capabilities

- `cloudflare-application-runtime`: 规定 console、Hono API、D1 持久化、队列发布和 Cloudflare 部署的运行契约与切换门槛。
- `docker-worker-runtime`: 规定外部 Docker worker 的任务消费、headed Playwright/Xvfb、登录态持久化、健康检查、优雅退出和 Sealos 部署行为。

### Modified Capabilities

- 无；现有 `browser-collect-parity`、`dispatch-tagging`、`notification-report` 与 `source-parsing` 的业务要求在迁移中保持不变。

## Impact

- 代码：新增 TypeScript 应用与共享领域包，逐步替代 `src/inboxserver/api`、`src/inboxserver/workers` 和相关基础设施适配器；现有 console 迁入工作区结构。
- 数据：需要 PostgreSQL 到 D1 的可重复迁移、Redis 队列到 Cloudflare Queues 的消息语义映射，以及浏览器登录态与文章归档的持久化方案。
- 部署：新增 Cloudflare Pages/Workers/D1/Queues 配置、worker Docker 镜像和 Sealos 模板；现有 Docker Compose 在迁移完成前继续作为回滚入口。
- 依赖：Node.js/npm、Hono、Drizzle、Wrangler、Cloudflare bindings、Playwright/Chromium/Xvfb；新增生产依赖须限制在经设计确认的最小集合。
- 运维：需要双跑去重、指标与健康检查、失败重试与死信验证，以及明确的数据切换和回滚步骤。
