## Context

### 关联需求与当前架构与约束

版本 1，本地实现；需求见 [proposal.md](proposal.md)。当前 main 干净基线为 41d2ece。apps/worker/main.ts 启动健康端口、Chromium 后运行轮询与 heartbeat；queue-processor.ts 持有业务编排，控制面持有任务租约、幂等和终态。无 docs/context 入口。GitNexus inbox-server 索引落后一个提交，仅导航，当前源码为事实源。

## Goals / Non-Goals

### 方案总览

本切片目标为独立可测的认证触发入口及既有处理器接线。采用 Functional Core 的配置/决策与 IO shell 分离；复用现有 QueueJob/控制面实体，不创建新的 Aggregate 或持久化 webhook inbox。生产 Cloud Run 发布和 PostgreSQL/Redis、Browser Run 迁移仍为后续同一主目标的必要工作，不能以本切片替代。

## Decisions

### 详细设计与接口契约

- DES-001（REQ-001/002）：请求是唤醒命令，不承载 QueueJob。POST /webhooks/worker 使用 WORKER_WEBHOOK_TOKEN；SHA-256 固定长摘要配合 timingSafeEqual 比较。GET 等方法为 405，凭据错误为 401，忙/未就绪/停机/依赖失败为 503（Retry-After: 5），成功为 200。只返回固定状态，不回显请求或异常。拒绝任意正文注入任务的替代方案；不新增存储或签名协议。
- DES-002（REQ-001/002）：抽取单批处理供 loop 和 webhook 共用，await pull→processQueueBatch→settle；webhook 在同一请求内串行调用，直到空领取后才返回 200。每次领取前检查小于 Cloud Run 900 秒超时的固定安全预算；预算不足返回 503 交由 Queue 重投，已完成批次靠 claimJob/effect 保持幂等。进程内 busy 标记以 finally 释放；它只保护单进程，跨实例仍复用控制面幂等。新任务、延期与失败由 Queue 与现有每小时 Cron 补偿，接口不自调用、不后台排队。不得仅靠 Promise.race 伪装取消仍在产生副作用的任务。
- DES-003（REQ-003）：WORKER_RUN_MODE=loop|webhook，默认 loop。webhook 要求 WORKER_PROCESSING_ENABLED=true 且独立非空 token，端口使用 PORT（缺省使用 HEALTH_PORT）。复用现有健康服务器和同端口路由，未知路径仍 404。webhook 无周期 heartbeat 或 pull；现有浏览器与持久化方式暂不改，故尚不满足完整云端部署验收。
- DES-004（REQ-004）：固定 worker.webhook.completed / rejected / failed 事件，记录枚举结果、status、durationMs，错误不附异常原文。代码当前没有已配置 OTel SDK/自动埋点，沿用 JSON 日志；不手写 W3C 解析或伪造 trace/span，不宣称 OTel 合规。正式跨云发布需另补 SDK/Instrumentation/SemConv 版本及 Trace、Metric、丢弃信号验证；本切片只验证稳定事件和敏感信息约束。
- DES-005（REQ-005）：API Queue consumer 先 stage 后 POST 唤醒，成功才 ackAll；网络错误、非 2xx 和配置不完整均抛错，由 Cloudflare Queue 重投，`message.id` 保证重复 stage 幂等。Cloud Run URL 与独立 token 从 API 运行时 Secret/变量读取，绝不记录 URL、token 或响应正文。未配置 URL 与 token 时保留现有 D1-only 行为，半配置报错。Cron 独立尝试一次唤醒作为延期积压补偿；失败记录固定事件且不阻断原定时发布。webhook 在有界请求内排空当前已到期消息；延期后的新到期消息仍由 Queue 重投或周期补偿。Queue consumer 的 15 分钟上限与 Cloud Run 请求超时、租约须在上线配置中协调。
- DES-006（REQ-006）：归档器在仓储 `save` 开始前将来源/提取失败表达为明确的写入前失败，并只记录安全状态码；从 `save` 开始直到镜像及事件写入完成的异常继续视为结果不明。任务处理器据此区分 `failed` 与 `uncertain`，保留现有 effect 幂等和历史 uncertain 人工核对边界。

## Risks / Trade-offs

### 备选方案与权衡

- 单批数量有界不等于执行时间有硬上限 → 当前处理器没有完整取消/续租能力；生产发布前必须验证任务时限和租约，长任务必须拆分，不能收到 202 后后台执行。
- 多批排空只在批次边界检查预算，不能中断已经开始的单批；单批超过请求/租约时限仍需独立修复。Cloudflare Queue 重试次数有限，超大积压可能只能由后续整点继续排空；须用负载测试确定容量上限并监测 Neon 已到期积压最老等待时间。
- 实例重建会丢本地文件，Browser Run 为 headless → 持久化迁移和来源兼容性未通过前禁止生产切换。
- 旧 runner 收到 SIGTERM 等待当前任务，不保证 10 秒内结束 → 本切片拒绝新的 webhook，保留租约恢复机制；完整 Cloud Run 退出验收仍未完成。
- bearer token 泄漏即可唤醒 → HTTPS、独立 Secret、禁止日志输出；云端 IAM 和调用者身份配置另行落实。
- 控制面仍为 D1 → PG/Redis 迁移需同步 API 数据所有权，不把本切片描述成已完成迁移。

## 初版迁移计划（2026-09-23 基线）

新增默认关闭的模式，不修改既有部署配置。先本地单测和类型构建；生产在外部依赖验收后显式启用 webhook。回退为 loop 模式及原镜像，无 schema 回滚。云端发布前验证从零唤醒、鉴权、重复任务、请求截止与 SIGTERM、队列补偿及多实例竞争。无需为未生效的平台迁移新增 ADR；最终替代 Sealos/D1 时应另建 ADR。

用户提供的 2026-09-23 22:12（UTC+8）配置快照确定后续目标为 Neon PostgreSQL（新加坡，数据库 dbx，TLS）和 Upstash Redis（东京，TLS/rediss，逻辑数据库尚未确认）。DBX 连接 ID 分别为 `41786b39-fc69-4fda-9665-4f1e97301bb4`、`1e68be8c-71cc-4d4f-a2d8-1bcaf922e546`；free 仅为 DBX 分组，不代表已核实服务商套餐或配额。本轮 DBX 只读查询再次确认 PostgreSQL 18.6、用户 `dbx_owner`、数据库 `dbx` 和 Redis `PONG`；PostgreSQL `public` 只有一张历史连接检查表，未读取用户行或修改数据。外部客户端凭据仍需经服务商提供并注入 Secret；不能把 DBX 内保存的连接视作 Cloud Run 已有凭据。API Queue/Cron 本地唤醒接线已实现；完整迁移还需确定数据隔离与迁移方案、Cloud Run 调用凭据注入及部署参数，并验证 Browser Run 来源兼容性与本地文件替代方案。

用户已选择 GCP 项目 `fullstack-fastapi-0923`、区域 `asia-east1`。初版只读 gcloud 核验该项目已有 `apps` Docker 仓库（`asia-east1-docker.pkg.dev/fullstack-fastapi-0923/apps`）和 Cloud Run 服务 `fullstack-fastapi-app`；后续已创建独立的 `inbox-server-worker` 服务并完成迁移切流，详见 2026-09-24 Changelog。本次修复只在本机构建新镜像，尚未推送或部署修复版。

## 验证策略与需求到设计追踪

REQ-001→DES-001/002，REQ-002→DES-001/002，REQ-003→DES-003，REQ-004→DES-004，REQ-005→DES-005，REQ-006→DES-006。测试在 apps/worker/tests 与 apps/api/tests，使用合成队列、可控 Promise 和注入的 fetch，验证响应等待结算、异常释放 busy、未授权零副作用、stage/wake/ack 顺序及文章归档失败阶段。当前修复版已本地验证；现有 Cloud Run 服务仍运行旧镜像，修复版真实 DB、Browser Run 和 Cloud Run 请求路径待独立发布后验证。
