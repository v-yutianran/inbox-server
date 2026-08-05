# Inoreader 分页与通知语义修复验收方案

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 变更 | `fix-inoreader-pagination-notifications` |
| 状态 | 本地与生产验收通过，Git 远端交付待当前授权 |
| 读者 | 开发、评审、发布与运维人员 |
| 验收范围 | 本地 Worker 门禁、Inoreader SPA 内容就绪、生产单来源采集与去重闭环 |
| 证据根目录 | 当前功能 worktree |
| 最后更新 | 2026-08-05 |

## 验收范围与排除项

验收范围包括 Inoreader SPA 内容就绪、虚拟列表按 article key 累积去重、稳定停止、轮次上限、YouTube/X 默认行为不变、通知“已入队”语义、零新增不通知、既有结构化成功事件，以及生产单来源首次采集与第二次去重闭环。

排除 Cloudflare API/Console、D1 schema、Queue envelope、其它来源、baseline 重置、历史 DLQ 重放和最终交付聚合通知。本次已获授权且仅滚动更新 Sealos Worker、执行两次真实 Inoreader 采集；未改写 Cloudflare、D1 schema、baseline 或 DLQ。

## 进入与退出条件

### 进入条件

- OpenSpec proposal、design 和 delta specs 已落盘。
- GitNexus 已基于当前 `origin/main` 重建索引并完成目标符号影响分析。
- 测试仅使用合成 Page stub，不连接真实用户数据或外部目标。

### 退出条件

- REQ-001～REQ-003 均有可执行 AC 和 TC，关键路径覆盖率为 100%。
- RED 用例先在旧实现上失败，GREEN 后全部通过。
- Worker 定向测试、全量测试、typecheck、build、OpenSpec 校验均通过。
- GitNexus 变更检测没有发现范围外的生产流程影响。
- 生产首次单来源采集发现预置的新收藏并完成入队，紧接的第二次采集为零新增且不重复通知。
- 未执行项、残余风险和上线前手工验证要求已明确记录。

## 需求、验收标准与用例追踪矩阵

| REQ | 需求 | AC | 验收标准 | TC | 证据 |
| --- | --- | --- | --- | --- | --- |
| REQ-001 | Inoreader 按稳定 article key 完整累积虚拟列表 | AC-001 | 连续轮次数量相同但 key 变化时累计全部唯一 key | TC-001、TC-002 | `browser-navigation.test.ts` 通过 |
| REQ-001 | Inoreader 按稳定 article key 完整累积虚拟列表 | AC-002 | 无新 key 时停止；持续有新 key 时最多执行 20 轮 | TC-003、TC-004 | `browser-navigation.test.ts` 通过 |
| REQ-002 | 其它浏览器来源行为不变 | AC-003 | 未提供稳定 key 时继续使用数量稳定停止行为 | TC-005 | `browser-navigation.test.ts` 通过 |
| REQ-003 | 通知准确表达队列阶段 | AC-004 | 非零通知显示“已入队”，不显示“发布成功”或“保存成功” | TC-006 | `notifications.test.ts` 通过 |
| REQ-003 | 通知准确表达队列阶段 | AC-005 | 零新增不通知；单个非零 collect job 仍只调用一次通知 | TC-007 | `job-handler.test.ts` 通过 |
| REQ-001、REQ-003 | 运行时行为可观测 | AC-006 | 复用 `worker.job.succeeded`，summary 可观察 source、collected、published 且不含文章敏感内容 | TC-008 | `queue-processor.test.ts` 随 Worker 全量测试通过 |
| REQ-004 | Inoreader SPA 内容就绪后再提取 | AC-007 | body 先出现而 article 延迟出现时必须等待可提取条目，禁止误报零新增 | TC-009 | `inoreader-readiness.test.ts` RED/GREEN 通过 |
| REQ-004 | Inoreader SPA 未就绪时安全失败 | AC-008 | 超时或登录失效必须显式失败，且不更新 baseline、不入队、不通知 | TC-010 | `inoreader-readiness.test.ts` 通过 |
| REQ-001、REQ-004 | 生产单来源去重闭环 | AC-009 | 首次采集 N 条并使 baseline 单调增加 N，第二次采集为零且无重复副作用 | TC-011 | Worker job、`worker_state`、effect、DLQ 与结构化日志生产证据通过 |

## 验收用例

### TC-001 同数量换页累积

- 前置：Page stub 连续返回两组各 30 条、key 完全不同的条目，第三轮重复第二组。
- 操作：传入 `stableKey` 执行 `scrollExtract`。
- 期望：返回 60 个唯一条目，顺序为首次发现顺序，并在第三轮停止。

### TC-002 重叠窗口去重

- 前置：第二轮同时包含上一轮重复 key 与新 key。
- 操作：执行稳定 key 滚动。
- 期望：重复 key 只出现一次，新 key 被追加。

### TC-003 无新 key 稳定停止

- 前置：第二轮没有任何新 key。
- 操作：执行稳定 key 滚动。
- 期望：第二轮后停止，不再滚动或等待。

### TC-004 轮次上限

- 前置：每轮均返回一个新 key。
- 操作：执行稳定 key 滚动。
- 期望：最多 evaluate 20 轮，返回 20 个条目。

### TC-005 默认行为回归

- 前置：不传稳定 key，连续两轮可见数量相同但内容不同。
- 操作：执行默认 `scrollExtract`。
- 期望：保持现有数量稳定停止行为，不改变 YouTube/X 调用契约。

### TC-006 通知文案

- 前置：source=inoreader、collected=30、published=30。
- 操作：格式化同步通知。
- 期望：文案包含“收集 30 条，已入队 30 条”，不包含最终交付成功表述。

### TC-007 通知触发边界

- 前置：分别构造零新增和非零新增 collect job。
- 操作：执行 job handler 单元测试。
- 期望：零新增不调用 notifier；非零任务在 state update 和 dispatch publish 后调用一次 notifier。

### TC-008 可观测性回归

- 前置：使用合成 collect job 和日志 spy。
- 操作：运行 queue processor 相关测试或检查现有测试证据。
- 期望：成功事件为 `worker.job.succeeded`，低敏感 summary 字段可用于核对采集/入队结果。

### TC-009 SPA 延迟渲染就绪

- 前置：Page stub 在 `document.body` 就绪后仍返回零个 article，随后延迟渲染包含稳定 key 和 HTTP 链接的 article。
- 操作：从 Inoreader collector 调用边界执行采集，不直接测试一个脱离调用链的浅层工具函数。
- 期望：采集等待 article 可提取后再进入 `scrollExtract`，返回延迟出现的唯一条目；不得使用固定 sleep。

### TC-010 未就绪与登录失效安全边界

- 前置：分别构造 article 永不出现和页面转入 login/signin 的场景。
- 操作：执行 Inoreader collect job。
- 期望：任务以可分类错误失败，不写 `baseline:inoreader`，不创建 dispatch job，不发送同步通知；其它 browser source 不受影响。

### TC-011 生产 Inoreader 两次采集

- 前置：已获得生产部署与真实数据复验授权；权威 `worker_state` 中 `baseline:inoreader` 的 B0=570，旧 Worker digest 为 `sha256:526ace4b…c8646d1`，Worker Ready，DLQ 为 333（Inoreader collect 为 94）。
- 操作：部署修复后的 Worker；第一次复用 03:20 scheduler 的唯一 Inoreader run，第二次使用不同 run id 直接发布单来源任务。
- 期望：第一次 `collected=3`、`published=3`、baseline=B0+3，dispatch/effect 成功且只通知一次；第二次 `0/0`，不新增 dispatch、effect、通知或 DLQ。
- 结果：第一次 3/3，baseline=573，三条 link job 和三条 Cubox effect 均为 done，通知 effect 为 done；第二次 0/0，baseline 保持 573，无通知 effect，DLQ 仍为 333/94。

## 执行记录

| 时间 | 用例/门禁 | 命令或方式 | 结果 | 证据摘要 |
| --- | --- | --- | --- | --- |
| 2026-08-04 | RED：TC-001、TC-002、TC-004、TC-006 | Worker 三文件定向测试 | 符合预期地失败 | 旧实现出现 5 个目标断言失败；job-handler 因 domain 未构建未计入 RED |
| 2026-08-04 | GREEN：TC-001～TC-006 | `npm run test --workspace @inbox/worker -- tests/browser-navigation.test.ts tests/notifications.test.ts` | 通过 | 2 files / 18 tests |
| 2026-08-04 | TC-007 | `npm run build --workspace @inbox/domain` 后运行 `tests/job-handler.test.ts` | 通过 | 1 file / 9 tests，零新增不通知、非零只通知一次 |
| 2026-08-04 | TC-001～TC-008 | `npm run test --workspace @inbox/worker` | 通过 | 20 files / 95 tests，包含成功事件可观测性回归 |
| 2026-08-04 | 全 workspace 回归 | `npm test` | 通过 | 41 files / 214 tests；Console 输出既有 jsdom canvas 提示但测试全绿 |
| 2026-08-04 | 类型与生产构建 | Worker typecheck/build；`npm run build` | 通过 | 全 workspace typecheck、API Wrangler dry-run、Console 与 Worker production build 通过 |
| 2026-08-04 | 规格与影响门禁 | OpenSpec validate；GitNexus compare `origin/main` | 通过 | OpenSpec valid；6 个已跟踪文件、7 个符号、4 条流程，风险为 medium，无 API/Console/数据库变更 |
| 2026-08-04 | TC-009 生产复现 | 仅发布 Inoreader collect job，run id `f298e0e5-c920-4248-bf4c-7e4ab9e9622c` | 不通过 | job `2867b967-2325-446c-8346-65da08e3b5f0` 完成但 summary 为 `collected=0,published=0` |
| 2026-08-04 | TC-009 只读时序诊断 | 使用同一凭据与代理记录 0/1/3/6/10 秒低敏感 DOM 计数 | 缺陷确认 | 0～3 秒为 0 条；6 秒出现 30 条，其中 3 条不在实际 `baseline:inoreader` 的 570 条 key 中；未输出标题、URL 或凭据 |
| 2026-08-04 | GitNexus 修复前影响评估 | `impact(collectInoreader, upstream)` | HIGH | 1 个直接调用者，沿 `collectWithContext → collectBrowserSource → collectSource` 影响 3 条采集流程；修复必须限定在 Inoreader 专用等待 |
| 2026-08-05 | RED：TC-009、TC-010 | `npm run test --workspace @inbox/worker -- inoreader-readiness.test.ts` | 符合预期地失败 | 3 个目标用例失败：延迟 article 返回零条；永不就绪与登录跳转被误报为成功 |
| 2026-08-05 | GREEN：TC-009、TC-010 与共享浏览器回归 | `npm run test --workspace @inbox/worker -- inoreader-readiness.test.ts browser-navigation.test.ts` | 通过 | 2 files / 20 tests；内容超时被既有分类器判为 retryable |
| 2026-08-05 | Worker 全量与构建 | Worker test、typecheck、build | 通过 | 21 files / 99 tests；共享 `waitForDocumentBody`、`scrollExtract` 与其它来源测试不变 |
| 2026-08-05 | 全 workspace 与 Python 兼容门禁 | `npm test`、typecheck、build；ruff、pytest、mypy | 通过 | npm 42 files / 218 tests；pytest 258 passed（9 个既有 warning）；mypy 103 source files |
| 2026-08-05 | GitNexus 修复后范围门禁 | 刷新当前 worktree 索引后执行 `detect-changes --scope all` | 通过 | 风险由相邻符号误映射的 high 收敛为 medium；仅 3 条 Inoreader 采集流程受影响，无 YouTube 或共享滚动流程 |
| 2026-08-05 | 生产部署预检 | GHCR 构建检查、源站/南京大学代理摘要校验、StatefulSet server-side dry-run | 通过 | Dockerfile 零告警；两个 registry 均解析到 `sha256:db860618…a354f`；dry-run 仅改变 originImageName、source revision 与主 Worker image |
| 2026-08-05 | Sealos Worker 滚动部署 | 仅 patch `inbox-server-worker-staging` 后等待 rollout、探针、心跳与日志稳定窗口 | 通过 | source revision=`96cd3f8a…32b7be`，三容器 Ready；`/healthz`、`/readyz` 200；WARP 冷启动自恢复一次；部署稳定窗口 87 秒无活动故障 |
| 2026-08-05 | TC-011 第一次生产采集 | scheduler run `09cd7532-9495-49d8-992e-00310430e770` | 通过 | job `b55064f5-e356-426d-83aa-174ea58402fc` 一次成功，3/3；baseline 570→573；3 个 link job、3 个 Cubox effect 和通知 effect 均 done |
| 2026-08-05 | TC-011 第二次生产采集 | manual single-source run `e76a953e-77ef-4ec7-8fab-0e344b84c05c` | 通过 | job `0b912405-7d7d-4f5e-9023-3f17ba36bc6e` 一次成功，0/0；baseline=573；无通知 effect；DLQ 零增 |
| 2026-08-05 | 生产业务后稳定门禁 | 同参数双采样 Sealos 日志/事件并复核当前探针 | 通过 | 80 秒内 warning 计数未增长，active failure=0；历史 readiness 超时最后发生于 19:22:58Z；两目标任务均有 `worker.job.succeeded`/ack |
| 2026-08-05 | Git 远端交付 | PR #43、#44、#45 | 通过 | 分页与通知语义修复、SPA 就绪等待和生产验收证据均已使用 merge commit 合入 `main` |

## 修复策略与执行顺序

修复任务以 [`tasks.md`](./tasks.md) 第 5～8 节为唯一执行清单，严格按 RED → GREEN → REFACTOR → 生产验收推进：

1. 先补 collector 边界的延迟渲染失败测试和未就绪安全测试，并更新 design/spec；没有红灯证据不得实现。
2. 只在 `collectInoreader` 中增加内容就绪等待，等待“存在可提取 article”，不修改共享 `waitForDocumentBody`、`scrollExtract` 或其它来源，也不使用固定延时。
3. 完成本地定向、全量、类型、构建、OpenSpec、验收文档和 GitNexus 门禁；任一失败即停止交付。
4. 获得单独授权后只更新 Sealos Worker，执行一次 3 条新增采集和一次零新增复验；不重置 baseline、不重放 DLQ。
5. 失败时回滚旧 Worker 镜像 digest；baseline 保持单调，已经发生的外部副作用不做自动逆操作。

## 未执行项与阻塞项

- Cloudflare API/Console 与 D1 schema：明确排除且未修改；本地主目录中的旧管理键返回 401，不影响 Worker 内部控制面与 D1 只读验收。
- 最终交付聚合通知：当前系统没有本次范围内的跨目标聚合回执契约，明确排除；本次三条 Cubox effect 已单独核对为 done。

## 残余风险

- Inoreader DOM 或 article key 提取规则未来变化时，稳定 key 可能失效；上线后应核对 `worker.job.succeeded` 的单次采集 summary。
- “至少一个可提取 article”就绪条件无法表达真正的空收藏页；若后续需要支持空账号，应先取得稳定空态 DOM 证据再扩展，当前不得用超时后的零条结果掩盖未就绪。
- 20 轮上限可能在极大 backlog 下仍不能一次取完，但会阻止无限滚动；后续 Cron 仍可继续处理。
- “已入队”只证明 dispatch jobs 已创建，不证明 Cubox 或文章归档最终成功。

## 验收结论

当前结论：**本地修复与生产验收通过**。REQ-001～REQ-004 的合成测试、全量回归、类型与构建门禁均通过；TC-009、TC-010 已证明延迟渲染会等待、未就绪会安全失败。TC-011 进一步证明线上首次采集 3/3、权威 baseline 单调增加、Cubox 与通知 effect 完成，紧接的第二次采集为 0/0 且无重复副作用或 DLQ 增量。Worker 在业务完成后稳定 80 秒且当前探针全部 Ready；无需回滚。

## 覆盖统计

| 指标 | 当前值 | 目标 |
| --- | --- | --- |
| 需求覆盖 | 4/4 通过 | 4/4 |
| 验收标准覆盖 | 9/9 通过 | 9/9 |
| 用例覆盖 | 11/11 通过 | 11/11 |
| 生产关键路径覆盖 | 1/1 通过 | 1/1 |
