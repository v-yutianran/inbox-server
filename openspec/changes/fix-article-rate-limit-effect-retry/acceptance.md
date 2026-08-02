# 文章队列限速与 effect 重试安全验收

## 目的与适用范围

本文供开发、验收和发布人员验证 `fix-article-rate-limit-effect-retry`。验收事实来源依次为
[需求文档](./requirements.md)、[技术设计](./design.md) 与
[增量规格](./specs/article-queue-retry-safety/spec.md)；本文只定义可执行的验收门槛，不扩展需求范围。

验收仅使用合成文章任务、隔离 D1、内存或桩 Queue、外部归档桩。生产环境仅允许读取历史 DLQ 的最小元数据，
不得发布真实历史消息、推断 payload、修改记录或执行生产重放。

## 验收结论

- 需求 `ARRS-001` 至 `ARRS-010` 均有设计决策、验收标准和自动化用例覆盖。
- 设计决策 D1 至 D9 覆盖全部行为、安全、迁移、回滚与验证约束。
- 需求文档中的实现选择项已由设计收敛，不存在会改变实现方案的未决项。
- 只有本文全部准入条件满足、AC-01 至 AC-08 全部通过且无阻断项时，才可判定验收通过。

## 测试层级与合成夹具

| 层级 | 目标 | 预期落点 |
| --- | --- | --- |
| 纯函数单元测试 | 状态转换、最晚 `retryAt`、分段延时、失败预算、批量限速决策 | `apps/api/tests/`、`apps/worker/tests/` |
| D1 集成测试 | 迁移、原子批量限速、延期持久化、effect 竞争、DLQ/envelope、幂等重放 | `apps/api/tests/` |
| Worker 编排测试 | handler 顺序、外部调用次数、Queue 结算、重投和退出恢复 | `apps/worker/tests/` |
| 契约与安全测试 | 内部认证、`dryRun`、响应 shape、日志脱敏、公开 API/Console 不暴露恢复材料 | `apps/api/tests/`、`apps/worker/tests/` |
| 回归与构建 | link/text/file 行为、限速配置、类型和构建 | 现有 workspace 测试与构建命令 |
| 迁移/回滚演练 | 隔离 D1 的前后快照、回滚顺序、非破坏性数据保留 | 自动化迁移测试与只读快照比较 |

统一合成夹具：

- 固定时钟 `T0=2030-01-01T00:00:00.000Z`，可显式推进到 `retryAt` 前后。
- 合成 `dispatch-item/article` 任务使用 `https://example.invalid/article/<n>`、合成标题和标签；
  `jobId`、`dedupeKey`、effect key 均固定且可重复。
- 外部归档使用计数桩，支持 `success`、`retryable`、`permanent`、`uncertain` 和“成功后进程退出”模式；
  每个用例必须断言调用次数。
- Queue 使用可观测桩，记录 ack、retry、`delaySeconds` 与发布次数；单次最大延时固定为 300 秒。
- D1 使用每例独立数据库或事务化隔离副本；加密密钥只使用测试密钥，任何断言和快照不得输出信封明文。
- 历史 DLQ 夹具仅含合成主键、摘要、digest 和时间，且刻意不含可恢复 payload。

## 双向追踪矩阵

### 需求到设计、AC 与用例

| 需求 | 设计决策 | 验收标准 | 自动化用例 |
| --- | --- | --- | --- |
| ARRS-001 | D1、D2、D3 | AC-01、AC-02 | AT-01、AT-02、AT-03、AT-04 |
| ARRS-002 | D1、D2、D3 | AC-01、AC-02 | AT-01、AT-02、AT-03 |
| ARRS-003 | D2、D3 | AC-01 | AT-01、AT-04 |
| ARRS-004 | D1、D3、D6 | AC-03 | AT-04 |
| ARRS-005 | D3、D6 | AC-03、AC-04 | AT-04、AT-05、AT-06 |
| ARRS-006 | D4、D6 | AC-05 | AT-07、AT-08、AT-09 |
| ARRS-007 | D5 | AC-06 | AT-10、AT-14 |
| ARRS-008 | D1、D3、D7 | AC-07 | AT-11 |
| ARRS-009 | D4、D5、D7 | AC-07 | AT-08、AT-09、AT-11 |
| ARRS-010 | D2、D3、D8、D9 | AC-08 | AT-12、AT-13、AT-14 |

### AC 到需求与用例

| AC | 需求 | 自动化用例 | 通过摘要 |
| --- | --- | --- | --- |
| AC-01 | ARRS-001/002/003 | AT-01、AT-03 | `retryAt` 前无损延期，到期后只执行一次且无自阻塞 effect |
| AC-02 | ARRS-001/002 | AT-02、AT-03 | 超过 300 秒的等待可分段延期，不消耗失败预算 |
| AC-03 | ARRS-004/005 | AT-04 | 并发竞争仅一个执行者产生外部副作用 |
| AC-04 | ARRS-005 | AT-05、AT-06 | 完成后重投或 ack 前退出都不重复归档 |
| AC-05 | ARRS-006 | AT-07、AT-08、AT-09 | 新任务有加密信封，认证且幂等地受控重放 |
| AC-06 | ARRS-007 | AT-10、AT-14 | 历史 DLQ 原字段前后逐项一致且无自动发布 |
| AC-07 | ARRS-008/009 | AT-11 | 状态链可关联，日志和所有响应均不泄露业务数据 |
| AC-08 | ARRS-010 | AT-12、AT-13、AT-14 | 非文章行为、额度配置与回滚兼容性无变化 |

### 设计决策到用例

| 设计决策 | 验收用例 |
| --- | --- |
| D1 显式文章状态机 | AT-01、AT-02、AT-03、AT-04、AT-07 |
| D2 限速先于 effect claim，批量评估窗口 | AT-01、AT-02、AT-04、AT-12 |
| D3 类型化延期与独立 Queue 结算 | AT-01、AT-02、AT-03、AT-04、AT-11 |
| D4 独立加密恢复信封 | AT-07、AT-08、AT-09、AT-11 |
| D5 历史 DLQ 物理只读 | AT-10、AT-14 |
| D6 `done`/`uncertain` 终态优先 | AT-05、AT-06、AT-09 |
| D7 结构化且脱敏的稳定事件 | AT-11 |
| D8 兼容 ADR 0005 的部署边界 | AT-12、AT-13、AT-14 |
| D9 合成数据与双层状态机验证 | AT-01 至 AT-14 |

## 自动化验收用例

### AT-01 窗口限速形成无损延期

- 前置：合成文章任务同时适用日窗口与固定窗口；固定窗口在 `T0+600s` 到期，归档桩调用数为 0。
- 操作：在 `T0` 领取并处理；读取任务、effect、限速桶和 DLQ；推进时钟至 `retryAt` 后再次领取。
- 预期：首次为 `deferred`，`deferred_until=retryAt`、`deferral_count=1`、`failure_attempts=0`；
  不存在本轮活跃 article effect，不新增 DLQ，不调用归档；到期后任务和 effect 为 `done`，归档调用数恰为 1。
- 日志：包含 `worker.job.deferred`，原因和 `retryAt` 正确；完成事件能以同一任务标识关联。

### AT-02 多窗口批量限速原子性

- 前置：日窗口允许、固定窗口拒绝，后者 `retryAt` 更晚；另设并发请求同时竞争最后一个可用配额。
- 操作：调用批量限速契约并并发执行两次；交换两个窗口顺序重复测试。
- 预期：拒绝时任何桶均不递增，返回全部拒绝窗口中最晚 `retryAt`；并发场景最多一个请求原子成功，
  不出现部分扣减；日限额、窗口限额及窗口秒数与变更前配置一致。
- 外部调用：0。

### AT-03 Queue 分段延期与早到重投

- 前置：`retryAt=T0+901s`，Queue 单次最大延时 300 秒。
- 操作：在 `T0`、每次 Queue 早到时和 `retryAt` 后重复领取、结算。
- 预期：前三段分别返回 1 至 300 秒的 retry 延时；每次早到保持同一绝对 `retryAt`，不进入 handler，
  `failure_attempts=0`、DLQ 增量为 0；到期后才允许归档且调用数恰为 1。
- 日志：每次延期均可由 `deferralCount` 排序，不能出现热循环。

### AT-04 effect 并发竞争无损延期

- 前置：两个执行者使用相同 `jobId`、`dedupeKey` 和目标；执行者 A 持有有效 effect 租约。
- 操作：A 阻塞于归档桩，B 同时领取；随后释放 A 并让 B 再次重投。
- 预期：B 得到带 `retryAt` 的 `busy` 延期，`failure_attempts` 和 DLQ 不增加；A 归档成功后 B 幂等完成；
  总外部调用数恰为 1。
- 日志：B 产生 `worker.effect.busy.deferred`，不产生 `worker.job.retryable_failed`。

### AT-05 外部成功后 ack 前退出

- 前置：归档桩成功，Queue ack 尚未执行。
- 操作：在 effect 和任务终态提交后模拟 Worker 退出，再投递同一消息。
- 预期：重投读取 `done` 终态并 ack，不再次调用归档；任务与 effect 仍为 `done`，外部调用数恰为 1。

### AT-06 外部结果不确定

- 前置：归档桩模拟“请求可能成功但响应不可确认”。
- 操作：结算为 `uncertain` 后自动重投，并对认证重放端点先 `dryRun`、再请求实际重放。
- 预期：effect 与信封保持 `uncertain`；自动重投不执行归档；重放端点均拒绝且发布数为 0；
  不能通过新去重键绕过终态，外部调用总数不超过 1。
- 日志：包含不泄露 payload 的 `worker.job.replay_rejected`。

### AT-07 真实失败预算与新 DLQ/envelope 原子性

- 前置：新合成文章任务，归档桩连续返回真实可重试错误，既有预算为 3 次。
- 操作：连续领取并失败结算直至预算耗尽。
- 预期：只有真实失败递增 `failure_attempts`；第三次后任务为 `dead`，新增一条 DLQ，DLQ 与状态为 `dead`
  的加密信封在同一原子结果中存在并关联；`attempts`、`deferral_count` 不参与 DLQ 判定。
- 日志：按次产生 `worker.job.retryable_failed`，最终仅一次 `worker.job.dead_lettered`；外部调用数恰为 3。

### AT-08 认证重放、dry-run 与运维幂等

- 前置：使用 AT-07 的合成新 DLQ；Queue 发布桩计数为 0。
- 操作：无认证、错误认证、正确认证 `dryRun=true`、正确认证实际重放、相同运维幂等键重复请求。
- 预期：前两次拒绝；dry-run 只返回可重放结论且 D1/Queue 均不变；实际重放保留原 `jobId`、
  `dedupeKey`、schemaVersion 并发布恰一次；重复请求不重复发布。所有响应不得含明文或加密信封字段。
- 日志：依次可见 `worker.job.replay_validated`、`worker.job.replay_published`，无业务 payload。

### AT-09 恢复信封生命周期与完整性

- 前置：分别创建 `active`、`dead`、`uncertain` 三种合成信封，并准备 digest/schema 不匹配样本。
- 操作：完成 active 任务；检查 dead/uncertain；对不匹配样本执行 dry-run。
- 预期：active 仅在任务和全部 effect 原子完成后删除，`done` effect 终态保留；dead/uncertain 不被定时删除；
  digest/schema 不匹配被拒绝且不发布；任何公开列表、Console 快照和通用 Worker 读取接口均看不到恢复材料。

### AT-10 迁移前后历史 DLQ 只读核对

- 前置：在隔离 D1 建立带多行合成历史 DLQ 的旧 schema 快照，记录行数及每行主键、错误摘要、digest、
  创建时间和全部原字段；记录 Queue 发布数为 0。
- 操作：应用迁移，再用只读 SQL 生成相同字段快照；对 `envelope_job_id IS NULL` 的历史行执行重放 dry-run。
- 预期：迁移前后行数和原字段逐项一致，历史行关联列为空并报告 `not_recoverable`；不推断内容、不写 envelope、
  不产生自动重放事件，Queue 发布数保持 0。

### AT-11 状态链、稳定事件与敏感信息禁漏

- 前置：依次触发限速延期、effect busy、真实失败、最终 DLQ、重放验证/发布/拒绝的合成场景；
  在合成 URL、标题、标签、Cookie、令牌和 payload 中放入唯一哨兵字符串。
- 操作：收集 Worker/API 结构化日志、内部端点响应、公开 API 响应和 Console 数据快照。
- 预期：日志覆盖 `worker.job.deferred`、`worker.effect.busy.deferred`、
  `worker.job.retryable_failed`、`worker.job.dead_lettered`、`worker.job.replay_validated`、
  `worker.job.replay_published`、`worker.job.replay_rejected`；事件含中文描述、任务关联标识、原因、
  `retryAt` 或结算、`deferralCount`/`failureAttempts`。所有输出对哨兵字符串和信封字段的扫描结果为 0。

### AT-12 非文章任务与限速配置回归

- 前置：冻结变更前 `channels` 中 article/link/text/file 的限额配置快照，准备三种非文章合成任务。
- 操作：运行 link、text、file 现有 Queue/handler 测试并各执行成功、可重试失败和永久失败分支；比对配置。
- 预期：非文章路径继续使用既有单桶契约和既有结算语义；状态、重试、DLQ 与外部调用次数不变；
  日限额、窗口限额、窗口秒数和 Queue 可见性/最大真实失败预算均与快照一致。

### AT-13 API 契约、类型与构建回归

- 操作：运行 API 路由/认证、迁移、control-plane、Worker handler/processor 测试，并执行根目录
  `npm test`、`npm run typecheck`、`npm run build`。
- 预期：全部命令退出码为 0；新增内部端点仍受现有内部认证保护；公开 API 和 Console 契约无新增恢复字段。

### AT-14 回滚与历史状态保留

- 前置：在隔离 D1 完成迁移，创建合成 `deferred`、dead envelope、uncertain envelope、done/uncertain effect，
  并保存历史 DLQ 快照。
- 操作：先回滚 Worker，再回滚 API；对 deferred 转换脚本仅执行 `--dry-run` 并核对拟影响行；以旧代码读取数据库。
- 预期：不执行破坏性 down migration；新增表和可空列保留；历史 DLQ、envelope、done/uncertain effect 均未删除或改写；
  旧代码可忽略新增字段。若 dry-run 不能证明 deferred 行可安全转换，消费保持暂停，验收判定为阻断而非强制转换。
- 外部调用与 Queue 发布：均为 0。

## 迁移前后生产只读核对

生产发布前后只允许执行相同的只读查询，并把结果保存为不含业务内容的摘要：

1. 统计历史 DLQ 总行数和文章 DLQ 行数。
2. 对历史行计算由主键、原错误摘要、payload digest、创建时间和原字段组成的不可逆集合摘要。
3. 发布后重复查询，要求行数和集合摘要完全一致。
4. 确认历史行未产生 envelope 关联，发布期间无历史任务 replay 事件。

该核对不能读取或回显 URL、标题、正文、Cookie、令牌或任何可重放 payload；生产数据不得复制到自动化测试。
任何差异均立即阻断发布，禁止通过修改历史记录“修正”验收结果。

## 准入、退出、阻断与判定

### 准入条件

- [ ] [proposal.md](./proposal.md)、[requirements.md](./requirements.md)、[design.md](./design.md)、
  [增量规格](./specs/article-queue-retry-safety/spec.md) 与
  [ADR 0005](../../../docs/adr/0005-stage-cloudflare-queues-in-d1.md) 引用有效。
- [ ] 实现范围与设计 D1 至 D9 一致，未引入新的行为或安全未决项。
- [ ] 所有自动化用例使用隔离 D1、合成任务和外部调用桩。
- [ ] 迁移前备份和只读历史 DLQ 摘要已准备，日志中无敏感字段。

### 退出条件

- [ ] AT-01 至 AT-14 全部自动通过，AC-01 至 AC-08 全部判定通过。
- [ ] 每个用例均断言任务/effect/envelope/DLQ 状态、失败与延期计数、日志事件、Queue 结算和外部调用次数。
- [ ] `npm test`、`npm run typecheck`、`npm run build` 与 OpenSpec strict validate 全部通过。
- [ ] 迁移前后历史 DLQ 只读摘要一致，非文章回归与回滚演练通过。
- [ ] 没有真实消息发布、生产 DLQ 写入或敏感数据回显。

### 阻断条件

- 任一限速或 busy 延期增加 `failure_attempts`、写入 DLQ、提前执行或留下自阻塞 effect。
- 同一任务/目标出现两次已确认外部归档，或 `done`/`uncertain` 被自动重新执行。
- 新任务进入 DLQ 时缺少可验证信封，或信封/恢复材料出现在日志、公开 API、Console。
- 历史 DLQ 任一原字段发生变化，或出现未授权的真实任务发布、重放、删除、补全。
- 非文章行为、限额配置、内部认证或公开契约发生非预期变化。
- 回滚需要破坏性 down migration，或无法证明 deferred 行可安全处理却继续消费。

### 判定规则

- `通过`：所有退出条件满足且无阻断项。
- `失败`：任何自动化断言、回归、构建、strict validate 或只读快照比较失败。
- `阻断`：环境无法隔离、需要真实用户数据/生产写入、迁移或回滚安全性无法证明，或发现会改变实现方案的未决项。
- `不适用` 不得用于跳过 ARRS-001 至 ARRS-010、AC-01 至 AC-08 或 AT-01 至 AT-14。

## 真实数据禁区

- 禁止把已知生产 DLQ、真实文章 URL/标题/正文、Cookie、令牌或用户目录复制为测试夹具。
- 禁止在自动验收中连接生产 D1 执行写操作、发布或重放历史 Queue 消息、删除或修改历史 DLQ。
- 禁止从 payload digest、日志或外部仓库反推历史任务内容。
- 未获得用户对真实数据验证或生产重放的单独明确授权前，任何生产写入验证均属于阻断项，不得降级为手工通过。

## 文档一致性检查

- [x] ARRS-001 至 ARRS-010 均追踪到设计决策、AC 和至少一个自动化用例。
- [x] D1 至 D9 均追踪到自动化用例，覆盖状态、契约、持久化、安全、迁移与回滚。
- [x] AC-01 至 AC-08 均有明确前置、操作、状态/日志/外部调用次数和判定条件。
- [x] 设计已收敛限速先于 effect、分段延期、独立加密信封和成功后立即删除等实现选择。
- [x] 生产历史 DLQ 只读、非文章回归、回滚验收和真实数据禁区均已纳入门槛。
- [x] 当前不存在阻塞实现的待确认项。
