## Context

版本 1；基于 [proposal.md](proposal.md) 和当前 `apps/worker`。现有 `browser.ts` 只启动本地 headed Chromium，`main.ts` 在 HTTP 监听后立即创建单例浏览器并把它闭包传给 job handler、文章归档。Cloud Run webhook 模式可能空闲超过 Cloudflare Browser Run 的会话存活时间。业务任务、租约与幂等仍归 API 控制面所有；浏览器连接属于 worker 请求期间的 IO 资源。

## 关联需求

REQ-001 至 REQ-003 及 AC-001 至 AC-004 见 [proposal.md](proposal.md)；行为约束见 [规格](specs/cloudflare-browser-run-runtime/spec.md)。

## 当前架构与约束

worker 通过控制面 HTTP 领取与结算 Cloudflare Queue 的持久收件箱任务，采集与文章归档共享一个 `Browser` 对象；旧镜像依赖本地 Xvfb。新的 Cloud Run 实例没有可靠的 `/data` 持久卷，浏览器配额与来源反爬能力均需真实验收。

## Goals / Non-Goals

目标是为 webhook 请求提供按需远程浏览器连接，并保留旧 Sealos headed 运行。只读 `wrangler whoami` 核对当前 Cloudflare 账号 ID 为 `b17ecbd7d539d10c63986e03bef75d9c`，其登录令牌具有 browser 写权限；这不等于 Cloud Run 已有可注入的长期 API 令牌。本文不更改任务状态机、PostgreSQL/Redis 迁移、文章 Git 工作区与 IMA marker 的持久化语义；这些依赖未完成前不发布生产。

## Decisions

### 方案总览与详细设计

- DES-001（REQ-001）：配置显式 `BROWSER_PROVIDER=local|cloudflare`，默认 local。cloudflare 模式要求 `CLOUDFLARE_ACCOUNT_ID` 和受保护的 `CLOUDFLARE_BROWSER_TOKEN`，且只能配合 webhook；拒绝本地 `BROWSER_PROXY_URL`，远程 CDP 使用独立 `BROWSER_CONNECT_TIMEOUT_MS`（默认 30 秒），不复用本地 Chromium 的 900 秒启动超时。启动阶段只校验配置，不创建远程会话。应用日志只记录 provider/枚举错误，不输出连接 URL 的敏感 query 或 token。复用现有 Playwright 依赖的 `chromium.connectOverCDP` 与 Authorization header，无额外浏览器 SDK。备选为直接调用 Browser Run REST 截图/API，但现有采集器依赖完整 Playwright 页面交互，不适用。
- DES-002（REQ-002）：批次先经现有 queue client 领取，再根据验证后的任务类型决定是否连接远程浏览器；空批次、无浏览器需求的批次不连接。需要浏览器时在同一请求内创建 browser，构造依赖该 browser 的 job handler/archiver，`processQueueBatch` 完成结算后在 finally 关闭连接。连接失败令本批返回 503，不能 ack 未完成的 lease。跨批不缓存 browser，避免超过官方默认空闲 60 秒和最长 keep_alive 10 分钟后使用陈旧会话。备选为常驻单例并检测 `isConnected()`，但空闲占用分钟数且来源于失效后重连的状态更复杂。
- DES-003（REQ-003）：为 Cloud Run 添加独立容器构建目标，只复制编译产物与运行依赖，不安装 Chromium/Xvfb，也不在入口脚本启动它们；旧 Dockerfile.worker/Sealos 启动路径继续保留。请求服务监听 `PORT`，启动探针使用真实初始化完成的 readiness，不把端口已开放视为任务就绪。Cloud Run 与 Artifact Registry 项目/区域/仓库已确认，具体发布仍受数据库、浏览器来源验收及凭据门禁约束。
- DES-004（REQ-003）：原有 headed 运行继续默认；远程模式以 `browser_provider_configured` 表示配置和处理器已准备接收任务，不宣称远程浏览器持续在线或产生 `browser_connected` 事件。连接故障只使该次请求失败，可由下一次请求重试。每个启用来源保留原基线/去重键，使用真实授权账号进行逐源 shadow 验收后才能切流。此前不得把纯单测当作来源兼容证据。

### 数据、接口与状态所有权

浏览器连接、页面和本地 staging 是请求范围资源；登录会话状态仍由控制面加密存储，job/lease 的真相仍归控制面。配置新增账号 ID、token，但不在数据库或仓库存储原文。webhook HTTP 状态沿用 `add-cloud-run-worker-webhook`：200 表示批次结算完成，503 表示可重试失败。worker 不直接接受 webhook 正文指定的业务任务。

## 接口契约

Worker 从 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_BROWSER_TOKEN` 读取远程连接配置，连接 Cloudflare Browser Run 的加密 CDP 端点，令牌只放 Authorization header。现有控制面 `/internal/queue/pull` 与 `/internal/queue/settle` 契约保持不变；webhook 的成功、失败和重试语义见 `add-cloud-run-worker-webhook`。连接身份与任务正文不交叉。

## Risks / Trade-offs

- Browser Run 为 headless，旧来源要求 headed → 逐源 shadow 验收登录、解析、基线、去重；不通过则保留旧 Sealos worker，阻止生产切流。
- Free 配额当前为 10 浏览器分钟/天、3 并发、20 秒最多新建 1 个浏览器，可能不足 → 以账号控制台核实并结合真实采集耗时决定容量；不能靠降低测试覆盖宣称可用。
- 跨批频繁创建会话有冷启动与限流代价 → 只在需要浏览器的批次创建，Cloud Run concurrency 初期设 1，后续以证据调整。
- Cloud Run 本地 `/data` 退出即丢，文章 Git 工作区与 IMA marker 仍依赖本地状态 → 迁移其持久化后才上线；本变更不暗中禁用它们。
- request timeout、queue visibility 与退出宽限期尚未协调 → 发布前以最慢浏览器任务和批量上限做真实请求内结算验收，超时不得伪报成功。

## 备选方案与权衡

常驻远程连接会因空闲过期而失效并持续占用浏览器分钟数；按批连接增加冷启动，但符合按需运行目标。复用旧 Docker 镜像保留 Xvfb 可减小构建改动，却不能保证 Cloud Run 不依赖本地浏览器；独立镜像更明确，也保留旧部署回退路径。

## Migration Plan

先在本地用合成浏览器/队列证明配置、按需连接和 finally 释放；再构建不含本地浏览器的 Cloud Run 镜像并做离线检查。通过数据/持久化、凭据、来源 shadow、Cloud Run 零实例唤醒与时限验证后，才在 `fullstack-fastapi-0923` 的 `asia-east1` 发布独立 worker 服务并逐步切流；回退使用原 Sealos 镜像与旧 headed 模式，不迁移或删除原资源。此跨平台浏览器及持久化取舍在切流前需要 ADR；本设计不替代 ADR。

## 验证策略与需求到设计追踪

REQ-001→DES-001；REQ-002→DES-002；REQ-003→DES-003/004。单测覆盖配置拒绝、空/非浏览器批次不连接、成功和失败时连接释放、旧模式兼容；构建检查镜像无 Xvfb/Chromium；真实来源、Cloud Run 请求及配额由人工授权验收记录，不冒充自动通过。当前没有改变本设计的待决策事项；上线所需凭据与来源验收尚未取得。
