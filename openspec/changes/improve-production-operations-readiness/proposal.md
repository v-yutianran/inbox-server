## Why

TypeScript、Cloudflare 与 Sealos 混合架构已经在线跑通，但当前可靠性仍主要依赖人工观察和单实例 Worker：线上快照存在 238 条 DLQ、39 条积压、25 条延迟任务，Worker 探针曾在浏览器工作负载期间超时，迁移变更还剩回滚演练未完成。现在需要把“可运行”提升为“可度量、可恢复、可重复发布”，并避免继续用已过时的 Python 优化计划承载新架构治理。

## What Changes

- 建立 Console、Cloudflare API 与 Sealos Worker 的分层 SLO、稳定事件、指标、告警和关联标识。
- 为 Worker 健康探针、浏览器主循环、优雅退出和 WARP 冷启动建立独立状态与可验证恢复边界。
- 建立积压、延迟任务和 DLQ 的分类、保留、告警、审核与安全重放闭环。
- 将镜像构建、D1 migration、部署、线上验证和回滚收敛为支持 dry-run、固定 digest、可审计证据的发布门禁。
- 明确单副本 Worker 的可用性边界、容量基线、数据保留和后续扩缩容准入条件。
- 不改变现有采集源、目标分发、API 路径、文章归档语义或 Cloudflare/Sealos 架构边界。

## Capabilities

### New Capabilities

- `production-operations-readiness`: 定义混合部署的健康、可观测性、队列治理、发布回滚、容量和数据生命周期要求。

### Modified Capabilities

无。

## Impact

- 未来实现主要影响 `apps/api` 的运维控制面与 D1 schema、`apps/worker` 的健康与队列编排、`apps/console` 的运维视图、Sealos manifest、Cloudflare/容器发布脚本及相应测试。
- 需要在 D1 和 Sealos 上增加只包含非敏感运行摘要的指标或事件；不得把 API Key、Cookie、浏览器登录态或文章正文写入日志和遥测。
- 当前混合架构 ADR-0004、D1 租约 ADR-0005 与 WARP ADR-0006 保持有效；若后续决定启用多副本 Worker 或引入新的外部可观测平台，须先补独立 ADR。
