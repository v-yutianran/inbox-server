## Context

动机见 [proposal.md](./proposal.md#why)，行为契约见
[article-queue-retry-safety/spec.md](./specs/article-queue-retry-safety/spec.md)。当前 Cloudflare
Queue 消息先进入 D1 `worker_inbox`，Sealos Worker 领取后再调用内部控制面领取
`worker_jobs` 与 `worker_effects`。文章路径目前先领取 effect，后消费内部限额；限速异常因此既会留下
`processing` effect，又会进入通用失败结算。与此同时，`worker_jobs.attempts` 在每次领取时递增，却被直接
用作失败预算，Queue 最长 300 秒的单次延期还可能早于 10 分钟 effect 租约到期。

`worker_inbox.body` 在 Queue 最终 ack 前保存完整信封，但 ack 会删除该行；现有
`worker_dead_letters` 只有不可逆 digest，无法在 DLQ 后重建任务。设计必须保持 Cloudflare API 为
控制面、Sealos 为执行面的现有边界，不改变文章提取、Git 归档、限额配置、公开 API 或 Console 的认证边界。

## Goals / Non-Goals

**Goals:**

- 把内部限速和有效 effect 竞争建模为可持久化、无损且可分段执行的延期。
- 将 Queue 领取次数、延期次数与真实失败次数分离，只有真实失败消耗 DLQ 预算。
- 在不削弱 `done` / `uncertain` effect 终态的前提下，保证文章归档至多一次。
- 为上线后的新文章任务保存加密恢复信封，并提供不回显 payload 的认证重放操作。
- 以稳定事件和合成测试证明状态转换，同时对历史 DLQ 保持只读。

**Non-Goals:**

- 不改变日限额、窗口限额、Queue 可见性超时和最多三次真实失败预算。
- 不修复或推断历史 DLQ payload，不自动重放真实任务。
- 不改变 link、text、file 的现有结算路径，也不改变文章提取与归档内容。
- 不把 `uncertain` 自动重置为可执行状态。

## Decisions

### 1. 文章任务采用显式状态机

文章任务使用以下逻辑状态；D1 是唯一状态事实源，Queue 只承载至少一次通知：

```text
QUEUED -> CLAIMED -> DEFERRED -> CLAIMED
                  -> DONE
                  -> FAILED_RETRYABLE -> CLAIMED
                  -> DEAD
                  -> UNCERTAIN
```

`DEFERRED` 只允许由内部限速或 effect `busy` 产生。它保存 `deferred_until`、原因和延期次数，清空本轮
执行错误但不增加 `failure_attempts`。`claimJob` 若发现尚未到期的延期，直接返回 `deferred + retryAt`，
不进入 handler、不领取 effect，也不增加失败预算；到期后才转换为 `processing`。

选择显式状态而不是把延期编码为 retryable 异常，因为后者会再次落入失败分类器，无法从数据库和日志中
证明预算未消耗。迁移将 `worker_jobs.status` 约束增加 `deferred`，并增加 `failure_attempts`、
`deferral_count`、`deferred_until`、`deferred_reason`。现有 `attempts` 保留为领取/执行观测计数，避免改变
既有字段含义；文章 DLQ 判定改为只读取 `failure_attempts`。

### 2. 限速在 article effect claim 前完成，且一次评估全部适用窗口

仅对 `dispatch-item/article`，handler 先调用新的批量限速契约，再领取 `article_archive` effect。控制面一次
评估日窗口与固定窗口：任一窗口拒绝时不递增任何桶，返回所有拒绝窗口中最晚的 `retryAt`；全部允许时才
在一个 D1 原子批次内递增适用桶。这样延期发生时根本不存在本轮 effect 租约，也避免先消费日额度、后被
窗口额度拒绝的部分扣减。

内部契约为 `POST /internal/rate-limits/consume-batch`，请求含不带业务内容的 scope、bucket、limit 与
windowSeconds 列表；响应为 `{ allowed, retryAt?, counts }`。既有单桶端点保留给非文章路径，因而
link/text/file 行为不变。若 D1 条件更新遇到并发冲突，控制面重新读取一次并返回允许或延期，不把冲突
包装成任务失败。

备选方案是限速后回滚 `processing` effect；它在 Worker 崩溃于“领取后、回滚前”时仍会留下自阻塞租约，
因此不采用。单纯缩短租约会削弱真实外部请求的并发保护，也不采用。

### 3. handler 返回类型化结果，Queue 结算分开处理延期与失败

文章 handler 返回判别联合：`completed(summary)` 或
`deferred(reason, retryAt)`；真实错误仍抛出并交给现有错误分类。effect `busy` 响应扩展为携带其
`retryAt`（由 `updated_at + effectLease` 计算），并映射为 `deferred`，不再抛出 `TypeError`。

`finishJob` 内部契约增加 `{ status: "deferred", reason, retryAt }` 分支。控制面持久化延期后返回
`settlement: "retry"`，延时为 `clamp(ceil((retryAt-now)/1000), 1, 300)` 秒。若 Queue 提前重投，
`claimJob` 仍返回同一 `retryAt` 并再次分段延期；因此实际执行绝不早于控制面下界。已到期或时间轻微倒退时
最少延时 1 秒，避免紧循环。

真实失败结算先原子增加 `failure_attempts`，再以新值套用既有三次预算和指数退避；延期与 Queue lease
领取均不修改它。`worker_inbox.attempts`、`worker_jobs.attempts` 和 `deferral_count` 仅用于观测，禁止参与
DLQ 判定。

### 4. 新文章任务使用独立、加密的恢复信封

新增 `worker_job_envelopes` 表，以 `job_id` 为主键、`dedupe_key` 唯一，保存 `schema_version`、
`payload_digest`、`envelope_encrypted`、生命周期状态和时间戳。控制面在首次成功解析并领取新文章任务时，
使用现有服务端加密能力保存规范化 QueueJob；只有持久化成功才能返回 `claimed`。表不进入公开查询、Console
快照或日志，Worker 也没有读取明文信封的通用接口。

生命周期为：处理中 `active`；进入 DLQ 后 `dead`；外部结果不确定时 `uncertain`；确认全部 effect 为
`done` 且 `worker_jobs` 已原子写入终态后删除信封。`done` / `uncertain` effect 终态继续长期保留，删除成功
信封不会削弱幂等。`dead` 与 `uncertain` 信封只能由明确的认证处置操作改变，不做定时清理。

认证内部端点 `POST /internal/dead-letters/:jobId/replay` 接受 `dryRun` 和运维幂等键。它在控制面内解密、
重新校验 schema/digest、确认 DLQ 可恢复且 effect 既非 `done` 也非 `uncertain`，再以原 `jobId`、
`dedupeKey` 和 schemaVersion 发布。`dryRun=true` 只返回可否重放及安全原因；实际调用通过持久化运维幂等键
保证重复请求不重复发布。响应和审计日志均不含信封字段。

### 5. 历史 DLQ 保持物理只读和可区分

`worker_dead_letters` 仅新增可空 `envelope_job_id` 关联列；迁移不更新任何已有行。空值明确表示
`not_recoverable`，重放端点返回不可恢复且不猜测内容。新 DLQ 与 envelope 状态在同一 D1 批次写入，避免
“已有死信但没有恢复材料”。历史验收只比较计数、主键、原字段摘要与时间，不触发写入。

### 6. effect 终态与不确定结果优先于恢复便利

稳定 effect key 继续由 `dedupeKey + destination` 生成。`done` 重投直接幂等完成；`uncertain` 重投直接
结算为不可自动执行，并保留信封供人工核对，但认证重放端点也必须拒绝。只有 `failed` 或过期
`processing` effect 能再次领取。任何控制面超时发生在外部调用之后时，Worker 先写 `uncertain`；无法确认
写入时让现有 effect 租约阻止自动重试，并记录高优先级审计事件，不能通过新去重键绕开。

### 7. 结构化日志不携带业务 payload

新增或调整稳定事件：`worker.job.deferred`、`worker.effect.busy.deferred`、
`worker.job.retryable_failed`、`worker.job.dead_lettered`、`worker.job.replay_validated`、
`worker.job.replay_published`、`worker.job.replay_rejected`。字段仅含 jobId/dedupe 指纹、原因、retryAt、
deferralCount、failureAttempts、结算和耗时；不得含 URL、标题、标签、Cookie、令牌或加密信封。

### 8. 本设计是 ADR 0005 的兼容演进

[ADR 0005](../../../docs/adr/0005-stage-cloudflare-queues-in-d1.md) 已决定 Queue 先落 D1、Sealos 仅经内部 API
领取的架构边界。本设计只补充同一 D1 staged queue 内的延期、失败预算与恢复材料，不改变部署边界、核心
技术选型或安全模型，因此无需新增 ADR。

### 9. 验证采用合成数据和双层状态机测试

纯函数测试覆盖延期秒数、最晚 `retryAt`、失败预算和状态转换；D1 集成测试覆盖批量限速原子性、迁移、
早到重投、并发 effect、DLQ/envelope 原子写入与幂等重放。Worker 测试注入合成 article 和外部归档桩，
覆盖“限速后到期成功”“成功后 ack 前退出”“uncertain 禁止重放”。回归继续运行 link/text/file、API
认证、类型检查和构建。生产验证只读历史 DLQ 元数据；自动化验收不得发布真实历史任务。

## Risks / Trade-offs

- [D1 表重建可能影响已有 `worker_jobs`] -> 迁移前后逐行核对主键、状态、attempts 与时间字段，并先在
  D1 副本执行；迁移只新增列和状态能力，不改历史 DLQ。
- [批量限速原子操作增加控制面复杂度] -> 将窗口决策和状态转换实现为纯函数，D1 层只执行条件语句与批次，
  并用并发集成测试验证无部分扣减。
- [加密信封扩大敏感数据持久化面] -> 复用现有服务端密钥、禁止列表/公开读取、成功即删除，dead/uncertain
  仅允许认证处置并写审计事件。
- [300 秒分段延期会增加 Queue/D1 请求数] -> 持久化绝对 `retryAt`，每段不消耗失败预算，并通过
  deferralCount 监控异常热循环。
- [外部成功但控制面终态写入失败仍存在不确定窗口] -> 保持 `uncertain` 优先和租约保护，不以可用性换取
  重复副作用风险。

## Migration Plan

1. 只读记录生产历史 DLQ 的计数和不可逆字段摘要；备份 D1，禁止导出或回显真实 payload。
2. 在隔离 D1 应用新迁移：扩展 `worker_jobs` 延期/失败预算字段与状态约束，创建 envelope、运维幂等记录，
   并给 DLQ 增加可空关联列；验证历史 DLQ 原字段逐项一致。
3. 先部署兼容新旧响应的 Cloudflare API，再部署使用显式延期结果的 Sealos Worker；部署期间暂停新的人工重放。
4. 用合成任务完成 AC-01 至 AC-08，核对日志事件、外部调用次数、failureAttempts、DLQ 和 envelope 生命周期。
5. 恢复正常消费，仅观察新文章任务；历史 DLQ 继续只读且不执行自动恢复。

回滚时先回滚 Sealos Worker，再回滚 API 代码；新增表和可空列保留，不执行破坏性 down migration。旧代码忽略
新增字段，未到期的 `deferred` 行由回滚前脚本在 `--dry-run` 核对后转为旧代码可领取状态；若无法证明安全，
保持消费暂停并前滚修复。任何回滚都不得删除 envelope、历史 DLQ 或 effect 终态。
