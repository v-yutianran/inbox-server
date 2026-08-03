## Context

当前仓库包含 React/Vite console、FastAPI server、asyncio worker、PostgreSQL、Redis 与 Nginx。server 负责 API、调度和持久化，worker 同时负责队列消费、目标分发、定时 browser collect、心跳以及文章 Git 归档；browser runtime 强制 `headless=False`，依赖 Xvfb 和可持久化登录态。

Cloudflare Workers 适合承载短生命周期 API、Cron Trigger、D1 与 Queues，但不适合现有长驻 headed Chromium 进程。Cloudflare Queue consumer 先把消息幂等写入 D1 租约收件箱，Sealos 中的外部 Docker worker 再通过内部 API 批量领取、确认或重试，因此混合部署可以保留 browser source 能力，同时让 console 与 server 共享 TypeScript 契约。

本设计对应 [proposal](./proposal.md)、[`cloudflare-application-runtime`](./specs/cloudflare-application-runtime/spec.md) 和 [`docker-worker-runtime`](./specs/docker-worker-runtime/spec.md)，长期决定记录在 [ADR-0004](../../../docs/adr/0004-typescript-cloudflare-docker-worker.md)。

迁移兼容基线如下，后续切片必须逐项核对：

- API 共 11 个方法/路径组合：`GET /healthz`、`GET /readyz`、`POST /sync`、`GET /queue`、`GET /queue/dlq`、`GET /channels`、`POST /login/{platform}/cookie`、`GET /login/{platform}/status`、`GET /api/operations/overview`、`GET /api/operations/sync-jobs`、`GET /api/operations/article-events`。
- PostgreSQL 长期表共 8 张：`telegram_offsets`、`dida_sync_states`、`login_sessions`、`credentials`、`incremental_baselines`、`sync_jobs`、`article_archive_events`、`subscriptions`；唯一性至少覆盖 bot token hash、Dida token hash、平台登录态、凭据名和 source baseline。
- Redis 主队列为 `queue:{link|text|file|article}`，死信为 `queue:<kind>:failed`，成功去重为 `queue:<kind>:done:<fingerprint>` 且 TTL 7 天；窗口桶为 `queue:<kind>:ratelimit:<window>`，每日桶为 `queue:<kind>:daily:<yyyyMMdd>` 且 TTL 25 小时；worker 心跳为 `operations:worker:heartbeat`，TTL 90 秒、每 30 秒更新。
- 当前限速为 link 固定窗口关闭、每日 500、间隔 5 秒；text 每 6 小时 25、每日 96、间隔 10 秒；file 每 30 分钟 1400、无每日上限、间隔 1 秒；article 限速来自 `channels.yaml`。
- server collect 每 10 分钟执行且 `max_instances=1/coalesce=true`；worker browser collect 每 60 分钟执行；队列空时每 60 秒轮询，限额满等待 30 分钟。
- 配置包含 10 个 source：`telegram`、`dida`、`github_stars`、`zhihu`、`bilibili`、`bilibili_toview`、`inoreader`、`youtube`、`x_bookmarks`、`x_likes`；3 个 destination：`cubox`、`flomo`、`jianguoyun`；文章归档已启用。

## Goals / Non-Goals

**Goals:**

- 建立 strict TypeScript 与 npm workspace，让 console、API、worker 共享纯领域模型和可执行契约测试。
- 用 Hono、Drizzle、D1、Cloudflare Queues 与 Cron Trigger 替代 server 的边缘运行职责。
- 用单独的 Docker worker 保留 headed Playwright/Xvfb、外部分发、文章归档与长任务能力。
- 通过幂等键、双跑验证、可重复数据迁移和明确回滚点，保证现有来源与目标的业务语义不退化。
- 生成可验证的 Sealos worker 部署模板，但在功能、数据和资源门槛完成前不切断 Python 基线。

**Non-Goals:**

- 不在第一批切片中一次性重写全部 collector、destination 和 console 页面。
- 不把 headed 浏览器迁入 Cloudflare Browser Rendering，也不把长任务伪装成普通 Worker 请求。
- 不在未完成数据核对、真实凭据验证和回滚演练前执行生产 D1 切换。
- 不改变现有来源解析、标签、通知和目标分发的产品语义。

## Decisions

### 1. 使用四单元 npm workspace

目录固定为 `apps/console`、`apps/api`、`apps/worker` 与 `packages/domain`。`packages/domain` 只包含纯函数、只读类型、队列消息 schema 和策略，不依赖 Cloudflare、Playwright、数据库或网络；IO 通过各应用的适配器注入。

选择 npm workspace 是为了遵循全局 Node 工具链并让三个运行单元独立构建。备选方案是保留现有 pnpm workspace，但会继续形成全局 npm 与单仓 pnpm 的双工具链。

首批依赖基线按 2026-07-31 官方 npm registry 固定为 Hono `4.12.33`、Drizzle ORM `0.45.2`、Drizzle Kit `0.31.10`、Wrangler `4.118.0`、Playwright `1.62.1`、Zod `4.4.3`、`@cloudflare/workers-types` `5.20260731.1` 与 `@cloudflare/vitest-pool-workers` `0.20.1`。worker 镜像固定使用 `node:22.17.0-bookworm-slim`，由同版本 Playwright CLI 只安装 Chromium 及其官方依赖；应用依赖与浏览器 revision 必须同步升级。

### 2. console 与 API 使用 Cloudflare 原生运行时

console 继续使用 React/Vite，静态产物部署到 Cloudflare；API 使用 Hono Worker。对外 REST 路径和 `X-API-Key` 兼容边界保持不变，内部 worker 使用独立 service token，两个凭据都只进入 Cloudflare Secret 或 Sealos Secret。

结构化长期状态进入 D1，并由 Drizzle schema 与版本化 SQL migration 共同管理。浏览器凭据只以加密密文进入 D1；明文仅在 worker 内存中短暂出现。需要存放大对象时再引入 R2，本次不为假设场景预建存储抽象。

备选方案是把 Hono API 也放入 Docker；它能减少运行时差异，但无法获得 D1、Cron Trigger 和 Queues 的原生部署边界，也偏离本次 Cloudflare 目标。

### 3. Docker worker 使用 D1 租约收件箱

API 与 Cron Trigger 只发布版本化任务消息；同一 Cloudflare Worker 的 Queue consumer 先按消息 ID 幂等持久化 D1，再确认 Cloudflare 消息。Docker worker 使用独立 service token 从 D1 收件箱领取消息并按租约处理。消息使用带判别字段的联合类型，至少包含 `schemaVersion`、`jobId`、`kind`、`dedupeKey`、`createdAt` 与对应 payload；外部 JSON 先作为 `unknown` 解析并通过运行时 schema 校验。

队列按至少一次语义设计：Cloudflare 消息只在 D1 inbox 持久化后 ack；业务副作用成功且幂等记录持久化后才结算 D1 租约；可重试错误延迟重放，不可重试错误进入死信处理。Cloudflare Queue 仅配置一个 Worker consumer。

备选方案是让 Sealos 直接调用 Cloudflare HTTP Pull API；这需要长期 `Queues Edit` API Token，而 Wrangler OAuth 会刷新且不适合作为常驻服务凭据，因此不采用。D1 租约收件箱只实现单副本 worker 所需的最小领取、可见性超时和批量结算，详见 [`ADR-0005`](../../../docs/adr/0005-stage-cloudflare-queues-in-d1.md)。

### 4. worker 保持 headed Chromium 与 PID 1 信号链

worker 镜像基于固定 Node 镜像，并使用 Playwright CLI 的 `install --with-deps chromium` 安装固定 revision，避免完整多浏览器镜像造成不必要的分发体积。入口先启动 Xvfb，再使用 `exec` 启动 Node，使 Node 成为 PID 1。Playwright 必须显式 `headless: false`，浏览器进程、队列拉取和健康服务都受同一个 `AbortSignal` 管理。

worker 提供仅 Pod 内使用的 liveness/readiness HTTP 端点，不创建公网 Ingress。登录态、Git 文章工作区和需要跨重启保留的文件挂载 Sealos PVC；事件循环时间戳等探针状态允许保留在进程内。

备选方案是 Cloudflare Browser Rendering；生产浏览器以 headless 模式为主，不能证明满足当前反爬约束，故不作为迁移基线。

### 5. 数据与切换使用 expand/verify/contract

先新增 D1 schema 和只读迁移工具，再从 PostgreSQL 导出稳定快照并导入临时 D1。对每张表核对记录数、稳定主键集合和关键不变量；随后让 Cloudflare API 与 Docker worker在禁用外部分发的 shadow 模式处理代表性任务，比较解析结果和幂等键。

切换时先停止旧 worker 写入，执行最后增量迁移，再启用新队列的单一生产者和单副本 worker。观察期内保留旧 Compose、PostgreSQL 快照和 Redis 数据；任何计数、幂等、凭据或分发异常都回滚到旧服务。只有观察期通过后才删除旧运行时，此删除不属于本变更的自动动作。

### 6. Sealos 只承载私有 worker

目标为 `sealos.run` 北京区 `bja`、工作区 `ns-tbs948af`。模板只包含 worker 及其持久化卷，不复制 Cloudflare 托管的 D1/Queues，也不为 worker 创建 Service/Ingress。worker 镜像发布为公开 GHCR 镜像，拉取地址将 `ghcr.io` 替换为南京大学代理 `ghcr.nju.edu.cn` 并继续固定同一 digest，因此不配置 registry pull Secret；业务敏感配置仍通过 Sealos Secret 注入且不进入模板输出或日志。

Chromium 容器从 `cpu=200m,memory=1024Mi` 的浏览器验证起点开始，按 Sealos 资源阶梯用冷启动、轻量页、真实页面、一次交互和 60 秒稳定窗口向上或向下验证，最终值以最低通过档为准。

### 7. WARP sidecar 提供受控出站网络

Sealos 北京区域的 worker Pod 使用固定版本的官方 Cloudflare WARP 客户端，以非 root、无额外 Linux capability 的本地 SOCKS5 代理模式提供出站网络；注册状态写入独立 PVC，sidecar 不创建 Service 或 Ingress。不得复制本机 ClashX 节点、订阅或个人代理凭据到仓库、镜像、Secret 或云端。

由于 WARP 代理内置 DNS 在目标区域不能可靠解析 Telegram、YouTube 和 Inoreader，worker 在 Pod loopback 上运行最小 HTTP CONNECT 适配器：先经 WARP 查询 Cloudflare DoH 得到目标 IPv4，再以该 IP 经 WARP 建连。Node HTTP 客户端与 headed Chromium 统一使用此适配器；只有代理返回 `warp=on` 且真实目标连通时，worker 才进入 ready 并开始领取任务。长期决定详见 [`ADR-0006`](../../../docs/adr/0006-warp-egress-sidecar.md)。

Git smart-HTTP pack 经适配器连续两次在 180 秒内无法完成浅克隆，而同 Pod 清空代理变量后 24 秒完成。文章归档因此把 Git 子进程限定为 HTTPS 直连 GitHub，并继续让正文抓取、通知和 headed Chromium 经过 WARP；Git 操作仍使用最小仓库 token、浅克隆和固定超时，不复用本机 ClashX 配置。

## Risks / Trade-offs

- [D1 与 PostgreSQL 的事务、时间和并发语义不同] → 用 Drizzle 隔离 SQL 方言，为关键不变量建立契约测试，并在切换前执行快照与增量两轮核对。
- [Queues 是至少一次投递，可能重复发送到 Cubox/Flomo/坚果云] → 所有任务携带稳定 `dedupeKey`，副作用前后写入持久化尝试记录，ack 只发生在成功提交之后。
- [browser storage state 含敏感 Cookie] → D1 仅存加密密文，密钥只存在 Cloudflare/Sealos Secret，日志禁止输出消息 payload、Cookie 或解密内容。
- [单副本 worker 暂时限制吞吐和高可用] → 第一阶段保持单副本以复用当前调度语义；只有 collector 锁与 destination 幂等证明通过后才允许横向扩容。
- [Playwright/Xvfb 资源消耗高] → 使用浏览器专用资源验收，不套用普通服务默认值；发生 OOM、重启或探针抖动即提升资源档。
- [WARP 注册或出站网络失效会阻断全部外部来源与目标] → 注册状态使用独立 PVC；代理、DoH 和 `warp=on` 都纳入启动门禁；控制面保留直连绕过并在切换前验证回滚。
- [迁移周期内双栈增加维护成本] → 每个纵向切片必须有删除旧路径的完成条件；未达到门槛的切片保持清晰的旧路径回滚入口。
- [当前仓库有既有未提交改动] → 本变更只修改精确路径并逐路径提交，不暂存或改写既有脏文件。

## Migration Plan

1. 建立 OpenSpec/ADR、npm workspace、共享任务 schema、Hono 健康端点和 worker 健康骨架，完成本地 typecheck/test/build/Docker 验证。
2. 建立 D1 Drizzle schema、迁移脚本与数据核对报告；只使用临时或本地 D1，不改生产绑定。
3. 迁移一个无浏览器、无外部分发副作用的代表性任务，验证 Queue pull、ack/retry、幂等和可观测性。
4. 在 Sealos staging 加入 WARP sidecar 与本地 DoH/CONNECT 适配器，验证非 root、无额外 capability、PVC 重建恢复和目标站点出站能力。
5. 迁移一个 browser source，在 Sealos staging 用持久化登录态和 headed Chromium 完成手工验收；未获得自动化 E2E 授权时不运行浏览器自动化。
6. 逐项迁移剩余 collectors、destinations、通知和文章归档，每项同步更新 parity checklist 与任务勾选。
7. 在外部分发关闭的 shadow 模式完成双跑和数据核对，演练从新 API/worker 回滚到现有 Compose。
8. 经用户确认生产数据迁移窗口后，停止旧 worker、执行最终增量迁移、启用新队列与单副本 Docker worker；观察通过后再单独决定是否下线 Python 服务。

## Open Questions

- Cloudflare console/API 的最终自定义域名和访问策略在部署前确认；本地与 staging 使用 Wrangler/平台默认域名。
- 文章 Git 归档的 Sealos PVC、远端仓库认证与备份恢复需在迁移该 destination 的切片中单独验证。
- 生产切换观察窗口长度与告警阈值需根据 shadow 运行数据确定，不在设计阶段猜测固定值。
