## Purpose

确保文章队列任务在内部限速、effect 租约竞争、Queue 重投和 Worker 重启期间保持可延期、可恢复且不重复执行外部归档副作用。

## ADDED Requirements

### Requirement: 内部限速必须形成无损延期
系统 MUST 将文章任务在外部分发开始前遇到的内部日限额或窗口限额视为延期，而不是任务失败。延期 MUST 不消耗失败重试预算、MUST 不创建 DLQ 记录，并 SHALL 使 Queue 在控制面返回的 `retryAt` 到达后重新提供任务；若单次 Queue 延时不能覆盖整个等待期，系统 MUST 继续无损延期直至到达 `retryAt`。

#### Scenario: 文章任务命中内部限速
- **WHEN** 文章任务在外部归档开始前命中尚未到期的内部限速窗口
- **THEN** 系统记录延期并安排不早于 `retryAt` 的重试，失败尝试数与 DLQ 数均不增加

#### Scenario: Queue 单次延时短于限速等待时间
- **WHEN** Queue 支持的单次重试延时早于 `retryAt` 到期
- **THEN** 系统再次延期该任务且不执行外部归档、不消耗失败重试预算

### Requirement: 限速延期不得持有活跃 effect 租约
系统 MUST 保证因内部限速而延期且尚未发起外部请求的文章任务不留下活跃的 effect `processing` 租约。任务在 `retryAt` 后恢复时 MUST 能够领取执行资格，而不会因自身上一轮延期得到 `busy`；任何 effect `busy` 结果 MUST 仅表示另一个仍有效的执行者，且 MUST 形成不消耗失败重试预算的短暂延期。

#### Scenario: 限速检查拒绝执行
- **WHEN** 文章任务尚未发起外部请求且内部限速检查返回拒绝
- **THEN** 系统不创建或不保留会阻塞该任务后续重试的活跃 effect 租约

#### Scenario: 并发执行者持有有效租约
- **WHEN** 同一文章 effect 已由另一个有效执行者持有
- **THEN** 当前任务被无损延期且不会将 `effect temporarily busy` 计入失败重试预算或写入 DLQ

### Requirement: 文章归档副作用必须保持幂等
系统 SHALL 以稳定的文章任务去重标识和 effect 标识协调重试。无论发生限速延期、Queue 重投、Worker 重启或租约竞争，同一文章任务对同一归档目标 MUST 至多产生一次已确认的外部归档副作用；已完成或结果不确定的 effect MUST 不被自动重复执行。

#### Scenario: 延期后成功恢复
- **WHEN** 同一文章任务在 `retryAt` 后被 Queue 再次投递且此前未发起外部归档
- **THEN** 系统执行一次归档并将任务与 effect 记录为完成

#### Scenario: 完成后发生 Queue 重投
- **WHEN** 已完成归档的文章任务因 Queue 可见性或网络原因再次投递
- **THEN** 系统确认既有终态并结算消息，不再次调用外部归档目标

#### Scenario: 外部结果不确定
- **WHEN** 外部归档请求可能已产生副作用但结果无法确认
- **THEN** 系统保留 `uncertain` 终态并禁止自动重复执行该 effect

### Requirement: 新文章任务必须具备受控恢复材料
变更生效后接收的新文章任务 MUST 在 Queue 消息被最终确认前，将完成受控重放所需的任务信封持久化到耐久存储。该材料 MUST 至少覆盖任务 schema 版本、稳定去重标识和重建文章归档请求所需的业务字段，并 MUST 保留到任务成功完成或运维人员明确处置；进入 DLQ 后 MUST 能由经过认证的内部运维流程读取并重放，而不得依赖从 payload digest 反推原始内容。

#### Scenario: 新文章任务耗尽真实失败预算
- **WHEN** 变更生效后的文章任务因真实可重试错误耗尽失败预算并进入 DLQ
- **THEN** 经过认证的运维流程可以从耐久存储恢复完整任务信封并以相同去重语义受控重放

#### Scenario: 新文章任务成功完成
- **WHEN** 文章任务及其所有已确认副作用完成
- **THEN** 系统可以按既定保留策略处置恢复材料，但必须保留足以阻止重复副作用的终态记录

### Requirement: 历史 DLQ 必须保持只读边界
本变更 MUST 不删除、覆盖、自动重放或伪造补全既有历史 DLQ。对于只含 payload digest、无法恢复原始任务信封的历史记录，系统 SHALL 保留其审计状态并明确标记不可自动恢复；任何真实数据恢复 MUST 由用户另行授权并提供可验证来源。

#### Scenario: 部署修复
- **WHEN** 修复版本及其数据迁移部署到已有生产 D1
- **THEN** 部署前后的历史 DLQ 记录数量和原始字段保持不变

#### Scenario: 历史记录缺少原始 payload
- **WHEN** 运维人员查看仅含 payload digest 的历史文章 DLQ
- **THEN** 系统报告该记录不可自动重放，不尝试由 digest 推断 URL、标题、标签或正文

### Requirement: 延期与恢复必须可观测且不泄露敏感数据
系统 MUST 为文章限速延期、effect 竞争延期、恢复执行和最终 DLQ 提供结构化日志。日志 MUST 包含稳定的小写点分 `event`、中文描述、任务关联标识、延期原因、`retryAt` 或结算结果以及失败预算状态；日志、Console 和公开 API MUST 不输出原始文章 URL、标题、Cookie、令牌或可重放 payload。

#### Scenario: 记录限速延期
- **WHEN** 文章任务因内部限速被延期
- **THEN** 日志可由任务关联标识追踪延期原因与 `retryAt`，且不含原始文章数据或凭据

#### Scenario: 记录恢复完成
- **WHEN** 延期任务在限速窗口到期后成功归档
- **THEN** 日志能关联同一任务的延期与完成事件，并显示未因延期消耗失败预算

