## Why

### 背景与问题

用户要求 Cloud Run Service 按需运行 worker，并通过 webhook 唤醒。当前 TypeScript worker 启动后持续拉取任务，不能把任务生命周期绑定到 HTTP 请求；本变更先交付可独立验证的 webhook 接收与有界消费入口。

## What Changes

### 需求清单

- REQ-001：新增显式 webhook 运行模式，只有经认证的 POST 请求可以触发有界、串行的队列排空；到期消息处理和结算完成前不得返回成功。
- REQ-002：独立触发凭据、拒绝未授权和并发触发，不接受用户提交任意任务内容；复用控制面的任务租约与幂等状态。
- REQ-003：监听 Cloud Run PORT，保留既有 loop 模式，webhook 模式无请求时不轮询队列或定时发送心跳。
- REQ-004：记录无秘密的稳定边界事件，提供可重复的本地测试及调用契约。
- REQ-005：Cloudflare Queue 将消息持久入库后，以独立凭据唤醒 Cloud Run；唤醒失败时不确认原 Queue 消息，并由周期触发覆盖延迟重试的积压。
- REQ-006：文章归档明确区分外部写入开始前的确定失败与可能已写入后的结果不明，避免把来源 API 拒绝误报为副作用不确定。

## Capabilities

### New Capabilities

- `worker-webhook-trigger`：定义认证唤醒、请求内批次处理、错误与重试契约。

### Modified Capabilities

- `article-queue-retry-safety`：补充文章归档失败阶段与效果终态的契约。既有 Sealos 常驻运行契约保持有效。

## Impact

影响 apps/worker 的 HTTP 接口、主进程编排和文章归档失败分类，以及 apps/api 的 Queue/Cron 触发与同区域测试；无新增数据库 schema 或运行时依赖。与 improve-production-operations-readiness 的健康与退出设计有交集，复用其健康模型；不改该 change 的既定范围。

## 范围与成功标准

### 验收标准

版本 2；状态：生产验收缺陷修复中。用户为持有触发凭据的调度端。AC-001：未授权请求不调用队列；AC-002：合法请求在预算内串行结算到期批次，只有确认无到期消息才返回 200，预算耗尽则返回可重试状态；AC-003：并发请求可重试且不并行消费；AC-004：旧 loop 配置兼容，webhook 模式无后台轮询；AC-005：异常返回固定错误且日志不泄露异常正文或凭据；AC-006：持久化后才唤醒，失败时原 Queue 消息可重试，Cron 可补偿积压；AC-007：归档写入前的确定失败不进入 uncertain，写入开始后结果不明仍冻结。

### 需求覆盖检查

验收映射：REQ-001→AC-002，REQ-002→AC-001/003，REQ-003→AC-004，REQ-004→AC-005，REQ-005→AC-006，REQ-006→AC-007。

## 非目标与依赖

整体目标仍为 Cloud Run Service、Artifact Registry、PostgreSQL/Redis、Browser Run。本切片不迁移 D1 或真实用户数据，不创建云资源，不启用实际云端调用，不切换远程浏览器。后续目标已确认为 GCP 项目 `fullstack-fastapi-0923`、区域 `asia-east1`、现有 Artifact Registry 仓库 `apps`；DBX 当前只读核验 Neon 与 Upstash 连通。运行时凭据注入、数据迁移及远程浏览器仍未完成；这些限制影响整体迁移而非本地入口实现。

无本切片待确认事项。2026-09-24 生产验收发现 Cloudflare Queue backlog 为 0 时 Neon inbox 仍有 10 条已到期消息，以及一条知乎 API 拒绝被标为 uncertain；本次修复只处理新请求路径和失败分类，不自动重放或改写已有业务任务。Queue 事件和现有每小时 Cron 继续负责新任务唤醒及延期积压补偿；发布后必须再核对两层队列与任务效果终态。
