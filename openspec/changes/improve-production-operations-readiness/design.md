## Context

本设计基于 `origin/main` 提交 `12105793cac10f5fd4df32b31282b10ca6ff665e`、GitNexus 3,513 个符号/6,215 条关系/196 条执行流，以及 2026-08-03 的线上只读快照。部署单元均符合云部署资格：Console 是 Cloudflare Pages 静态 Web，API 是 Cloudflare Worker，headed Chromium Worker 是 Sealos 长驻任务；三者应分别评估，不把单仓库误判为一个进程。

线上基线已经可用：API `/healthz`、`/readyz` 与 Console 返回 200，Sealos StatefulSet 为 1/1，Worker、Mihomo、WARP 均 Ready，Worker 心跳新鲜且已开启处理。风险集中在运行治理：Worker 仅一个副本；WARP 冷启动出现过一次重启；浏览器负载期间 Worker readiness 曾超时；队列快照为 backlog 39、deferred 25、failed 1、processing 1，DLQ 238 而 dead job 224，相差 14 条；`worker_replay_operations` 为 0；TypeScript 迁移仍有“演练停止新 Worker 并恢复旧 Docker Compose”一项未完成。

源码已经具备良好基础：配置有 schema 校验，镜像用 digest 固定，D1 有租约、重放和关键索引，Worker 有 PID 1 信号链、结构化事件与心跳，管理 API Key 仅保存在 `sessionStorage`。主要缺口是没有统一指标/SLO/告警与数据保留闭环，探针和工作负载仍共享失效域，DLQ 只有操作能力而没有治理策略，发布证据和回滚尚未形成一条可重复流水线。

### 云原生就绪评分

| 部署单元 | 无状态 | 配置外置 | 横向扩展 | 启停健康 | 可观测性 | 边界清晰 | 合计 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Console | 2 | 2 | 2 | 2 | 0 | 2 | 10/12 |
| API | 2 | 2 | 2 | 2 | 1 | 2 | 11/12 |
| Worker | 1 | 2 | 0 | 2 | 1 | 2 | 8/12 |

整体约 9.7/12，结论为“可稳定部署，但生产运维成熟度不足”。Console 缺少客户端错误与可用性遥测；API 已无状态且边界清晰，但没有完整 SLI；Worker 因持久化浏览器/WARP 状态、单副本与副作用写入约束，当前不具备直接横向扩展条件。

## Goals / Non-Goals

**Goals:**

- 先消除会阻碍故障发现和安全恢复的 P0 缺口，再补齐可观测、发布、容量与成本治理。
- 让每个线上异常都能回答“何时开始、影响什么、为何发生、能否重放、如何回滚”。
- 保持所有写操作支持 dry-run，真实重放、清理、migration、部署和回滚必须有明确执行边界与事后验证。
- 在不依赖本机 Docker 的前提下验证完整线上流程。

**Non-Goals:**

- 不改采集源、目的地、文章提取优先级、归档格式和公开 API 语义。
- 不在本变更中立即增加 Worker 副本、替换 D1/Queues、移除 WARP/Mihomo 或引入服务网格。
- 不删除现有 238 条 DLQ、旧 Python 运行时或历史 Docker 数据；这些动作须在分类、备份和回滚演练后另行批准。
- 不把第三方 APM 作为前置条件；优先利用现有稳定事件、Cloudflare 与 Sealos 原生数据面。

## Decisions

### 1. 按失效域分层，而不是只保留总览在线/离线

API、Worker、浏览器、Mihomo 与 WARP 分别维护状态机：`starting`、`ready`、`degraded`、`stopping`、`failed`。健康服务只读取内存快照和最近时间戳，不等待浏览器、网络或 D1 IO；Worker 在依赖未就绪时停止领取相应任务，但继续续租和完成可安全收尾的任务。

替代方案是单纯放宽 Kubernetes 探针超时。它能减少误杀，但无法识别事件循环阻塞，也不能阻止 Worker 在代理未就绪时继续领取任务，因此只作为容量调参而不是根治方案。

### 2. 以稳定事件生成指标，先不引入新的强依赖

在现有 `event` 规范上增加统一字段：`service`、`deploymentVersion`、`jobId`、`leaseId`、`itemKind`、`source`、`destination`、`outcome`、`durationMs`。在 API/Worker IO 边界生成计数、时延和年龄指标，Console 只读取聚合结果。初始 SLO 先运行 14 天基线，再冻结阈值；门禁至少覆盖 API 可用率、Worker 心跳新鲜率、最老可执行任务年龄、任务成功率和直接提取/浏览器回退结果。

替代方案是立即接入完整 OpenTelemetry/APM。当前规模下会先增加费用、采样和敏感字段治理复杂度；只有原生数据无法满足跨服务关联和告警时再通过 ADR 选择外部平台。

### 3. DLQ 治理先分类，再重放或清理

先生成只读一致性报告，解释 `DLQ - dead jobs = 14` 的来源，并按失败原因、任务类型、部署版本和年龄建立队列。重放严格沿用现有 envelope、effect key 和限速检查；批量操作只允许“逐条验证后批次执行”，每次记录 `requested`、`validated`、`published`、`rejected` 或 `failed`。不允许用清表或无条件重新入队解决积压。

保留策略采用状态驱动的初始值：心跳 7 天，完成任务及 envelope 30 天，DLQ 和重放审计 90 天，幂等 effect 至少覆盖最长重试窗口并默认 90 天。正式执行前必须先跑 14 天 dry-run 统计，确认不会破坏去重与审计需求。

### 4. 发布单元独立，但共享一次发布证据

发布清单固定源码提交、Console deployment、API version、D1 migration、Worker/Mihomo/WARP digest、Sealos revision 和 Secret 版本摘要。顺序为备份与预检、expand migration、API/Console、Worker、隔离 canary、稳定窗口；任一门禁失败即停止。GitHub Actions 资金阻塞期间先提供本地 TypeScript 发布 CLI，必须支持 `--dry-run`，后续只迁移执行环境，不改变契约。

回滚按单元选择上一 Cloudflare 版本和容器 digest；D1 migration 只允许向后兼容的 expand 阶段先上线，contract 删除须跨版本稳定窗口后另做。迁移变更 6.4 的旧 Compose 回滚演练先以备份、只读预检和隔离环境完成，不直接覆盖现有线上数据。

### 5. 保持单副本，先建立容量与恢复目标

当前 Worker 有浏览器登录态、文章仓库写入和 WARP 状态卷，多副本会扩大重复副作用风险。P0/P1 阶段维持 `replicas: 1`，定义初始 RTO 15 分钟和浏览器/WARP 状态每日备份；D1 队列与业务状态以平台备份能力和导出证据定义 RPO。只有到达率/消化率、CPU、内存、任务 P95 和探针延迟证明单副本不足，且租约、幂等、归档锁与登录态隔离测试全绿，才为 active-passive 或分片方案新建 ADR。

### 6. 用隔离 canary 替代真实目标试投递

新增带显式 canary 标识的测试任务，目标适配器使用 dry-run/sink，覆盖 API 入队、领取、直接 Defuddle、短内容拒绝、Playwright 回退、归档模拟与结算。canary 使用仓库内固定 fixture 或受控公开测试页，不使用真实用户数据，也不写 Cubox、Flomo、坚果云和真实文章仓库。

### 7. 分阶段执行与退出门槛

| 优先级 | 范围 | 退出门槛 |
| --- | --- | --- |
| P0 | 回滚演练、探针隔离、DLQ 差异审计、积压年龄、隔离 canary | 回滚路径可重复；24 小时无探针超时；238 条 DLQ 全部可分类；关键 canary 全绿；无未解释新增 DLQ |
| P1 | 指标/SLO/告警、重放审计、保留 dry-run、发布证据、Secret 校验 | 控制台可看趋势；告警演练成功；发布/回滚同参数 dry-run；14 天保留报告无幂等风险 |
| P2 | 容量压测、成本预算、备份恢复、active-passive 决策、旧运行时收敛 | 有容量上限与月度预算；恢复演练达成 RTO/RPO；多副本有 ADR 或明确维持单副本；旧资产有保留/移除结论 |

## Risks / Trade-offs

- [指标和日志增加 D1/日志成本] → 只记录低基数聚合与稳定关联标识，设采样、保留期和月度预算告警。
- [探针隔离后可能掩盖业务卡死] → readiness 同时检查最近工作进展时间戳和依赖状态，liveness 只判断进程健康，SLO 再判断业务停滞。
- [重放产生重复外部副作用] → 重放前验证 effect key、envelope、目标状态和限速，默认逐条执行并记录结果。
- [保留清理破坏去重窗口] → 先连续 14 天 dry-run，保留期限不得短于最长重试与幂等窗口。
- [单副本仍是可用性瓶颈] → 先用明确 RTO、备份和自动恢复降低风险，多副本只在并发安全证据充足后启用。
- [本地发布 CLI 仍依赖操作者环境] → 固定工具版本、输出证据清单并在 GitHub Actions 恢复后原样迁移。

## Migration Plan

1. 冻结 14 天运行基线并建立 P0 告警，不改变现有任务处理语义。
2. 完成迁移变更 6.4 的隔离回滚演练，记录旧 Compose、Cloudflare 版本和 Worker digest 的恢复证据。
3. 先上线健康状态机、积压年龄和 DLQ 一致性只读接口，再上线隔离 canary。
4. 上线稳定事件与聚合指标，经过告警演练后把 P0 阈值纳入发布门禁。
5. 上线重放审计与保留 dry-run；观察 14 天后才允许执行清理。
6. 把现有手工发布步骤收敛为 TypeScript CLI，依次演练 dry-run、部署失败停止和回滚。
7. 完成容量/恢复演练后决定是否提出多副本 ADR；未通过则保持单副本并更新容量上限。

回滚原则：每个阶段保持旧字段和旧读路径可用；API/Console 回退上一 Cloudflare 版本，Worker 回退上一 digest；任何 D1 contract 删除必须延后到跨版本稳定窗口，且不得在同一发布中执行。

## Open Questions

- 告警首选渠道使用邮件还是独立即时消息通道；实现前需确认值班可达性。
- 14 天基线结束后需确认最终 SLO 和数据保留期限；本文数值是安全起点，不作为未经观测的永久阈值。
- 多副本优先选择 active-passive 还是按任务类型分片，取决于容量压测和文章归档并发测试结果。
- 是否在 Cloudflare 管理 API Key 外再加 Cloudflare Access；若引入，将作为新的认证边界另写 ADR。
