# 生产运维就绪改进技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 状态 | 待验收设计 |
| 版本 | 1.0 |
| 日期 | 2026-08-03 |
| 读者 | 开发、验收、发布与生产运维人员 |
| 范围 | OpenSpec change `improve-production-operations-readiness` |
| 唯一需求输入 | `requirements.md` 1.0 |
| 维护入口 | 本文件；需求变化先更新 `requirements.md` 并重新完成设计门禁 |
| 关联决定 | ADR-0004 混合运行时、ADR-0005 D1 暂存 Cloudflare Queues、ADR-0006 WARP 出站 sidecar |

## 背景、目标与非目标

当前系统已采用 Cloudflare Pages Console、Cloudflare Worker API、D1、Queues、Cron，以及 Sealos 单副本 headed Chromium Worker、Mihomo、WARP。现有任务租约、幂等 effect、恢复信封、DLQ、逐条重放、结构化事件与心跳是本设计的基础，不重写业务语义。

本设计把当前“可访问”提升为可分域诊断、可度量、可安全恢复、可重复发布，并为单副本建立容量和恢复边界。设计不改变公开 API、采集源、分发目标、限速、文章提取顺序、归档格式或去重结果；不增加 Worker 副本，不引入外部 APM、Cloudflare Access 或服务网格，不执行生产删除、重放、部署或回滚。

## 当前事实与约束

- Cloudflare API 是控制面和唯一公网服务端入口；Console 不直接访问 D1、Queues 或 Sealos。
- D1 持有任务、租约、幂等 effect、恢复信封、DLQ、重放审计、心跳及运维聚合数据；Cloudflare Queues 只负责至少一次投递，不是真实状态源。
- Sealos Worker 执行采集、浏览器提取、分发和归档；Mihomo 提供路由，WARP 提供出站网络能力，浏览器与代理状态均可能独立失败。
- Worker 保持 `replicas: 1`。PVC 上的浏览器、WARP 和归档相关状态不能据此推定可并发共享。
- D1 与 Queues 不存在跨系统原子提交；所有发布任务必须先在 D1 形成可重试的意图，再由现有暂存/发布链投递。
- 最终 SLO、错误预算、保留期、告警渠道和生产 RPO 需等待 14 天基线或专项批准；批准前仅作为候选参数，不驱动破坏性动作。
- 当前未授权浏览器自动化 E2E；本设计只定义后续授权后的验收入口。

## 方案总览

```mermaid
flowchart LR
  Operator[运维/发布人员] --> Console[Cloudflare Pages Console]
  Console -->|认证只读/管理 API| API[Cloudflare Worker API]
  API --> D1[(D1 状态与审计)]
  API -->|写入发布意图| Inbox[D1 Queue Inbox]
  Inbox --> Queue[Cloudflare Queues]
  Cron[Cloudflare Cron] --> API
  Queue --> Worker[Sealos Worker 单副本]
  Worker --> Browser[headed Chromium]
  Worker --> Mihomo[Mihomo]
  Mihomo --> WARP[WARP]
  Worker -->|心跳/状态/聚合事件| API
  Worker --> Targets[真实外部目标]
  Canary[合成 Canary Sink] -.零真实副作用.-> Worker
```

依赖方向固定为 Console → API → D1/Queues，Queues → Worker → 浏览器/代理/外部目标。Worker 不承担运维策略审批，Console 不持有服务令牌，Cloudflare 不承担 headed 浏览器或持久登录态执行。

## 组件职责与数据所有权

| 组件 | 职责 | 不负责 |
| --- | --- | --- |
| Console | 展示分层状态、趋势、阈值、证据；提交显式确认 | 保存长期管理凭据、展示 payload |
| API | 鉴权、只读聚合、运维计划校验、审计、告警编排 | 浏览器任务、绕过 D1 直接批量重放 |
| D1 | 运维事实、任务状态、指标桶、审计与发布意图 | 网络投递成功的推定 |
| Queues | 至少一次传输已获准任务 | 业务状态、审计和幂等真相 |
| Worker | 能力探测、领取决策、任务执行、结算、心跳 | SLO 审批、自动扩容 |
| Browser | DOM/登录态相关采集与回退 | Worker 进程健康 |
| Mihomo/WARP | 路由与出站能力 | 任务状态和业务重试策略 |

## 健康状态机

所有失效域统一使用 `starting | ready | degraded | stopping | failed`，但分别计算。状态快照契约为：

| 字段 | 约束 |
| --- | --- |
| `component` | `console | api | worker | browser | mihomo | warp` |
| `state` | 五态枚举 |
| `reasonCode` | 稳定低基数代码，不含异常原文和敏感值 |
| `observedAt` / `expiresAt` | RFC 3339；过期快照不得显示为 `ready` |
| `deploymentVersion` | 源码提交、Cloudflare version 或镜像 digest 的非敏感标识 |
| `canAcceptWork` | 当前能否领取该能力所需的新任务 |

```mermaid
stateDiagram-v2
  [*] --> starting
  starting --> ready: 必需配置与依赖就绪
  starting --> failed: 启动门禁失败
  ready --> degraded: 局部依赖或业务进展异常
  degraded --> ready: 恢复且观察窗通过
  ready --> stopping: 收到停止信号
  degraded --> stopping: 收到停止信号
  stopping --> failed: 超时或无法安全收尾
  stopping --> [*]: 已停止
  degraded --> failed: 职责能力完全丧失
  failed --> starting: 经授权恢复或新实例启动
```

liveness 只读取独立健康服务的内存快照，不等待浏览器、网络、D1 或当前任务；readiness 由配置有效性、停止标志、依赖状态、心跳/进展新鲜度和任务领取能力共同计算。浏览器、Mihomo 或 WARP 失败时，纯函数 `acceptance decision` 按任务能力需求返回 `accept | defer | reject`；依赖任务不得新领取，已领取任务只能安全完成、延期或释放租约。

## 运维接口契约

现有公开路径保持不变，新增接口位于既有管理认证边界内：

| 方法与资源 | 权限 | 语义 |
| --- | --- | --- |
| `GET /operations/health/components` | 只读 | 六个组件状态、原因、时间、版本 |
| `GET /operations/queue/summary` | 只读 | 可执行/处理中/延迟/不可执行数量、最老年龄、最早恢复时间 |
| `GET /operations/metrics` | 只读 | 当前值、窗口趋势、候选或已批准阈值、采集时间、版本 |
| `GET /operations/dlq/consistency` | 只读 | 逻辑冻结时间、分类明细、计数、摘要、未解释数 |
| `POST /operations/replays/plan` | 管理 | 零写入 dry-run，返回逐条判定和 `planHash` |
| `POST /operations/replays/execute` | 管理+显式确认 | 仅执行同对象、同参数和同 `planHash` 的计划 |
| `GET /operations/replays/{operationId}` | 只读 | 返回重放状态和审计主体 |
| `GET /operations/retention/report` | 只读 | 候选清理范围、风险和前后摘要，不删除 |

所有响应使用稳定 `requestId`，错误统一区分 `unauthenticated`、`forbidden`、`stale_plan`、`invalid_material`、`idempotency_conflict`、`rate_limited`、`dependency_unready` 与 `internal_error`。错误不得回传凭据、payload、真实 URL、标题或恢复信封。

## DLQ 一致性与安全重放

一致性报告以调用时 `freezeAt` 为逻辑截止点，在一个只读查询计划中关联 DLQ、dead job、恢复信封和重放记录。每条记录必须且只能进入 `matched`、`historical_migration`、`orphan_dlq`、`dead_without_dlq`、`already_replayed`、`missing_envelope` 或 `integrity_anomaly`；其中异常类别仍是“已分类但未解决”，`unexplainedCount` 必须为 0。报告包含分类计数、稳定 ID 摘要和查询前后只读摘要，不修改数据。

重放计划逐条检查对象版本、信封完整性、effect/幂等状态、目标副作用状态、租约、当前限速、依赖健康和调用权限。`planHash` 由规范化对象 ID、参数、快照版本和判定结果生成；实际执行若任一输入或快照变化则返回 `stale_plan`，要求重新 dry-run。

```mermaid
stateDiagram-v2
  [*] --> requested: 显式执行且 operationKey 唯一
  requested --> validated: 计划哈希与当前状态一致
  requested --> rejected: 权限或材料不满足
  validated --> published: D1 发布意图已被 Queue 确认
  validated --> failed: 发布重试耗尽
  requested --> failed: 内部校验故障
```

`operationKey` 唯一约束保证重复请求复用原操作。执行事务先写审计及 D1 queue inbox，再由既有发布器投递 Cloudflare Queue；投递至少一次，最终副作用仍由 job/effect key 幂等。禁止 API 在审计之外直接向 Queue 发布，禁止批量请求绕过逐条判定。

## 指标、SLI 与 SLO 数据模型

指标按分钟/小时窗口聚合，维度仅允许 `service`、`component`、`itemKind`、`source`、`destination`、`outcome`、`extractionPath`、`deploymentVersion`；任务和租约 ID 只用于事件关联，不作为指标标签。

| SLI | 计算依据 |
| --- | --- |
| API 可用性 | 窗口内成功请求数 / 有效请求数 |
| Worker 心跳新鲜度 | 心跳年龄及窗口内满足阈值的比例 |
| 最老可执行任务年龄 | `available_at <= now` 且可领取任务的最大年龄 |
| 任务结果 | 完成、延期、重试、死信的计数与成功率 |
| 提取路径 | direct、short-rejected、browser-fallback 的结果与耗时 |
| 依赖状态 | browser、mihomo、warp 各状态持续时间比例 |
| 容量/成本 | CPU、内存、重启、P50/P95、到达率、消化率、D1/日志用量与月成本 |

指标点至少含 `metricKey`、窗口起止、聚合值、样本数、维度、采集时间和部署版本。SLO policy 另存 `candidate | approved | retired` 状态、窗口、目标、错误预算和批准证据摘要。连续 14 天前只允许 `candidate`；告警实例按 `pending → firing → recovered` 去重，首次越界和恢复各通知一次。

## 发布与回滚 CLI

唯一发布入口为基于 CAC 的 TypeScript CLI，消费不可变 release manifest。业务输入包含源码提交、Console/API 目标版本、migration 集、Worker/Mihomo/WARP digest、Sealos revision、Secret 引用版本、备份标识、canary 集和退出门槛；manifest 只保存引用与摘要，不保存 Secret。

CLI 提供 `plan`、`apply`、`rollback` 三类动作，`apply` 与 `rollback` 均支持 `--dry-run`。dry-run 与实际执行读取同一 manifest 并生成同一 `planHash`；实际写入还必须显式提供该哈希确认。dry-run 仅做只读解析、权限探测、版本/摘要核对、migration 兼容检查、备份可恢复性检查和目标差异输出，不部署、不迁移、不回滚、不发送生产 canary。

执行顺序固定为：全部预检 → 备份证据 → expand migration → API → Console → Worker → 隔离 canary → 稳定窗口。任何预检失败时线上版本和数据零变化；执行中失败则停止后续单元，根据步骤日志恢复已改变单元到上一版本，并验证 D1 双版本兼容、健康、错误率、积压和合成关键流程。证据记录每步 `planned | started | succeeded | failed | compensated`、开始/结束时间、版本摘要和脱敏验证结果，支持中断后从最近已确认步骤恢复，不重复成功步骤。

## 数据保留、备份与恢复

- 保留报告覆盖心跳、完成任务、任务信封、DLQ、重放审计和幂等 effect；初始 7/30/90 天仅为候选。
- 未批准期限前不提供生产删除执行；批准后清理仍需同参数 dry-run 连续 14 天、显式确认、分批游标、可中断恢复和前后对账。
- 保留期不得短于最长重试、幂等保护、审计、备份和争议处理窗口；禁止无条件清表与长事务全表删除。
- D1 备份记录平台快照/导出标识、schema version、表计数与稳定摘要；Worker、浏览器和 WARP 状态使用 Sealos PVC 快照或等价备份，Secret 仅备份版本引用。
- 恢复只先在隔离环境进行，使用合成数据或脱敏元数据，核对 schema、记录数/稳定 ID、启动门禁与关键流程；RTO 目标为 15 分钟，RPO 在批准前不宣告达成。
- 旧 Python 运行时、旧 Docker 数据和部署资产在回滚窗口、备份恢复与删除授权均满足前保持零删除、零改写。

## 数据迁移与兼容回滚

D1 migration 采用 expand/contract：先新增可空字段、表和索引，双版本均能读取；回填分批、可重入并记录游标；新读路径稳定后再停止旧写入。contract 删除不得与功能发布同批，必须跨稳定窗口另行批准。应用回滚只回退 Cloudflare version 与容器 digest，不以逆向破坏性 migration 为前提。

健康、指标和重放接口均为新增管理契约；现有字段与路径保持可读。若阶段退出门槛失败，回退新增读取和发布单元，保留已写入的向后兼容运维数据，避免数据丢失。

## 可观测性与安全

关键事件使用 `<领域>.<动作>.<结果>`，含中文描述、`service`、部署版本、不可逆关联 ID、任务/租约类型、来源/目标类别、结果与耗时。状态转换、领取拒绝、重放、发布、回滚、备份、恢复、清理和告警均有稳定事件；领域纯函数不记录日志，由最近 IO/编排边界记录。

管理、Worker 服务身份和只读身份分离。所有写操作认证、授权、显式确认并记录审计主体。API Key、服务令牌、Cookie、storage state、加密密钥、文章正文、真实 URL/标题和通知内容禁止进入日志、指标、告警、Console、发布证据和构建产物。所有验证产物执行敏感哨兵扫描，命中必须为 0。

canary 使用固定合成 fixture、显式 canary 标识、隔离存储和无副作用 destination sink，覆盖入队、领取、direct、短内容拒绝、浏览器回退、归档模拟和结算；真实 Cubox、Flomo、坚果云和文章仓库调用必须为 0。

## 发布阶段与停止条件

| 阶段 | 交付 | 停止条件 |
| --- | --- | --- |
| P0 | 分层健康、队列年龄、DLQ 报告、隔离 canary、回滚演练 | 探针超时、未解释差异、真实副作用或恢复超过 15 分钟 |
| P1 | 指标趋势、SLO/告警、重放审计、发布 CLI、保留报告 | 敏感命中、门禁可绕过、告警不可关联或 dry-run/执行计划不一致 |
| P2 | 容量成本、备份恢复、多副本决策证据 | RPO 未批准、并发安全未通过或试图自动扩容 |

## 验证策略

| 层级 | 职责 |
| --- | --- |
| 单元 | 状态转换、领取决策、SLI 聚合、planHash、保留选择、发布/回滚计划纯函数 |
| 集成 | D1 migration、冻结一致性查询、唯一操作键、queue inbox、指标窗口、分批恢复 |
| 契约 | 运维 API 鉴权、错误语义、过期状态、同参数 dry-run/execute、旧公开 API 不变 |
| 组件 | 独立健康服务在长浏览器任务下响应；Mihomo/WARP 故障时领取隔离 |
| 端到端 | 获得授权后运行隔离 canary、告警/恢复、发布失败停止、版本回退和备份恢复 |
| 运行时证据 | 24 小时零探针超时、14 天脱敏基线、RTO、对账摘要、版本和敏感扫描 |

当前不运行浏览器自动化 E2E，也不执行生产重放、清理、发布、回滚或删除。验收设计应以替身依赖和隔离环境覆盖自动化，并把需要单独授权的线上步骤列为人工门禁。

## 关键决定与权衡

1. **D1 为运维事实源，Queues 仅传输**：避免双写后无法判断发布结果；代价是增加 inbox 发布延迟与补偿状态。该决定延续 ADR-0005，无需新 ADR。
2. **健康快照与工作负载 IO 分离**：保证探针预算；代价是 liveness 不能单独证明业务进展，必须结合 readiness、心跳和 SLI。
3. **原生聚合优先于外部 APM**：减少依赖、费用和敏感治理；代价是跨域查询能力有限。若引入外部 APM，另立需求和 ADR。
4. **expand/contract 而非 down migration**：确保应用可回退；代价是旧结构需跨稳定窗口保留。
5. **继续单副本**：避免登录态、归档和外部副作用并发风险；代价是可用性受 RTO 上限约束。多副本只有完成 REQ-P2-003 并批准独立 ADR 后才可设计实施。

## 风险、假设与实施交接

- 指标增长可能增加 D1/日志成本：仅保留低基数桶并用月度成本趋势约束。
- 状态快照可能陈旧：所有读取必须校验 `expiresAt`，陈旧一律降级而非沿用 ready。
- D1/Queue 发布可能重复：以 operation key、queue inbox 和 effect key 三层幂等收敛。
- 清理可能破坏幂等与审计：最终期限未批准前保持报告-only。
- 实现人员须按 `tasks.md` 的 RED-GREEN-REFACTOR 顺序推进；接口、数据或边界变化必须回到最早受影响门禁。
- 实施前须对具体函数、路由与部署流程执行 GitNexus impact analysis；本文不授权生产操作或 Git 交付。

## 需求到设计追踪

| 需求 | 设计章节 |
| --- | --- |
| REQ-P0-001～003、NFR-001 | 健康状态机、组件职责、验证策略 |
| REQ-P0-004 | 运维接口、指标数据模型 |
| REQ-P0-005～007、REQ-P1-010 | DLQ 一致性与安全重放、权限边界 |
| REQ-P0-008、NFR-005 | 隔离 canary、验证策略 |
| REQ-P0-009、REQ-P1-005～007、NFR-002/006 | 发布与回滚 CLI、迁移与兼容回滚 |
| REQ-P1-001～004、NFR-004/007 | 指标、SLI/SLO、可观测性 |
| REQ-P1-008 | 数据保留、备份与恢复 |
| REQ-P1-009、NFR-003 | 启动门禁、Secret 与敏感字段边界 |
| REQ-P2-001～003 | 容量成本、单副本决定与 ADR 门禁 |
| REQ-P2-004/005 | 备份恢复、旧资产保留 |

## 待决策事项

- OPEN-001 告警渠道与责任人：只阻塞告警投递验收。
- OPEN-002 最终 SLO、错误预算和窗口：只阻塞阈值批准。
- OPEN-003 最终保留期限：只阻塞生产清理。
- OPEN-004 生产 RPO：只阻塞生产恢复目标判定。
- OPEN-005 多副本路线：只阻塞后续多副本 ADR 与实现，本变更保持单副本。
- OPEN-006 Cloudflare Access 或外部 APM：可选增强，若采用须另建需求与 ADR。

阻塞后续验收设计的待决策项：**无**。
