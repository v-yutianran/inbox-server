# Worker webhook 验收

版本 1；日期 2026-09-23；环境：当前本地 checkout；基线 41d2ece；状态：本地验证，未放行。来源：[需求](proposal.md)、[设计](design.md)。

## 验收范围与准入条件与退出条件

只验证本地 webhook 切片，使用合成数据、假的处理回调和可控 Promise。实现前影响分析和 RED，退出要求聚焦测试、类型检查、构建及适用回归有实际证据。

## 需求追踪矩阵与验收用例

| 用例 | 需求/标准 | 前置条件与步骤 | 预期 | 证据/实际结果 |
|---|---|---|---|---|
| TC-001 | REQ-002 / AC-001 | 合成 token；发送缺失/错误 token、GET、未知路径 | 401/405/404；处理次数为零 | worker-webhook.test.ts 直接路由/handler 单测通过；真实 HTTP 未验证 |
| TC-002 | REQ-001 / AC-002 | 正确 token；处理 Promise 暂停后再完成 | 响应等待结算；成功 200；空队列成功 | handler 等待与既有 queue-processor 单测通过；main await 接线源码确认 |
| TC-003 | REQ-002 / AC-003 | 第一次调用保持运行，再次触发；完成后第三次触发 | 第二次 503+Retry-After，第三次可执行；没有并发 pull | 可控 Promise 单测通过，retryAfterSeconds=5；实际 HTTP 头未联网验证 |
| TC-004 | REQ-003 / AC-004 | 默认 loop、合法 webhook、不完整 webhook 配置，PORT 覆盖 | 旧配置兼容、缺少 token/processing 拒绝、webhook 无周期 pull/heartbeat | config.test.ts 通过；无周期调用仅 main 源码确认，未启动真实进程 |
| TC-005 | REQ-004 / AC-005 | 依赖抛出含秘密的错误，再次触发 | 固定 503、日志无秘密、busy 被释放 | worker-webhook.test.ts 错误脱敏与恢复单测通过 |
| TC-006 | REQ-005 / AC-006 | 合成 Queue 先 stage 再唤醒；模拟网络失败、HTTP 503、HTTP URL 和 Cron 积压 | 只在 HTTPS 唤醒成功后 ack；失败重投沿用消息 ID；Cron 失败不阻断定时发布 | queue-consumer.test.ts、scheduled.test.ts 通过；真实 D1/Cloud Run 未执行 |

## 执行记录、验收结论与覆盖统计

6/6 有本地检查证据，其中 TC-004 运行接线只做源码审查，TC-006 只用合成 Queue/fetch；完整 HTTP/进程验收尚未完成。最终 `npm test` 为 270/270 通过，`npm run typecheck`、`npm run build` 通过，Cloud Run linux/amd64 镜像本地构建通过。早期 socket/ps 沙箱失败及其复验范围详见 [tasks 验证记录](tasks.md)。结论：不放行发布；不把单测替代真实 HTTP、断连、SIGTERM 或数据库验收。

OpenSpec verify：6 条 Requirement 均有本地实现映射，设计与实现一致；云端请求、数据与来源验证未完成，保持 active。main 模式和退出顺序缺真实运行证据；最终 GitNexus 合并视图为 HIGH/11 flows 且索引落后，源码审查修复了 optional 属性、loop 端口兼容、断连后提前关闭依赖和不安全 webhook URL。`openspec validate add-cloud-run-worker-webhook` 通过。

## 未执行项、残余风险与发布建议

DBX 只读连通性现已复核；GCP 项目/区域和现有 Artifact Registry 仓库已确认。Queue/Cron 唤醒端已有本地合成证据，但全链路数据库迁移、运行时凭据注入、Browser Run 来源兼容、云端零实例唤醒、请求截止/10 秒退出与多实例争用未执行。它们是整体迁移的发布前置条件，不因本地单测通过而消失。本切片不创建、变更或迁移真实数据；不宣称生产可切换。

## 版本 2：生产请求路径缺陷修复（2026-09-24）

本节只覆盖 2026-09-24 生产验收发现的两个缺陷。旧版验收是历史记录，不能代表修复后的结果。验收采用合成批次和文章归档响应，生产验证只读核对 Neon、Cloudflare Queue 与 Cloud Run 日志；现存 `uncertain` 项须先核对目标端再单条处置。

| 用例 | 需求/标准 | 前置条件与步骤 | 预期 | 证据/实际结果 |
|---|---|---|---|---|
| TC-007 | REQ-001 / AC-002 | 首批处理期间有新到期批次；等待首批完成 | 同一 webhook 请求继续串行拉取，直至空批次才返回 200；不并发处理 | `worker-webhook.test.ts` 通过；合成三次拉取，前两次非空、末次为空；生产未验 |
| TC-008 | REQ-001 / AC-002 | 合成时间推进到请求安全预算上限，另有到期批次 | 批次之间停止，返回可重试 503；不在响应后后台处理 | `worker-webhook.test.ts` 通过，预算 720 秒且停机后均不再拉下一批；真实超时未验 |
| TC-009 | REQ-006 / AC-007 | 知乎 API 在归档写入前返回非成功响应 | 效果记为 failed，job 进入既有失败/重试路径；仅记录安全错误码和 HTTP 状态 | `article-archive.test.ts`、`job-handler.test.ts` 通过；合成 503 及审计写入失败，未连接真实来源 |
| TC-010 | REQ-006 / AC-007 | 归档写入已开始后抛错或结果无法确认 | 保留 uncertain，禁止自动重放 | `article-archive.test.ts`、`job-handler.test.ts` 通过；合成 save/mirror 异常；该用例记录时既有生产项尚未处置，后续单条核验与结算见最终生产证据 |

生产验收准入：本地聚焦与项目门禁通过、镜像可构建、发布目标版本及回退镜像可定位。发布后的退出条件：这 10 条已到期 inbox 消息均有对应 job 与 effect 终态、Neon 中到期积压归零，并观察至少两个自然整点周期；Cloudflare Queue backlog 仅作辅助证据。单批处理无法在批次内部取消，若该批自身超过 Cloud Run 请求上限，仍有超时风险，须在真实日志中观察并保留重试保护。未获独立部署与真实数据处置授权时，生产项保持待验。

发布前只读核对：`fullstack-fastapi-0923` / `asia-east1` 的 Cloud Run 服务 `inbox-server-worker` 仍将 100% 流量指向 `inbox-server-worker-00002-pfc`，镜像摘要为 `sha256:b71deb2187ae7cc984dc18ceb408adc9d40d73ca8e61c603534a4d16d4e5ba8e`，并发 1、请求上限 900 秒。修复版本地镜像 `inbox-worker:local-fix-20260924` 的镜像 ID 为 `sha256:277433e54160eb703e7f87c60ff9ef5820efc14eef10d94499d42f45278c343f`，尚无 Artifact Registry 摘要或 Cloud Run 修订版。

版本 2 本地证据（生产部署前状态）：聚焦 webhook 9/9、文章与任务 41/41；全仓 `npm test` 378 passed / 9 skipped、`npm run typecheck`、`npm run build`、Python lint/mypy/非 E2E 292 passed / 1 skipped，Cloud Run linux/amd64 镜像本地构建及 OpenSpec validate 通过。以上只说明本地实现可构建且合成契约通过；当时尚未推送 Artifact Registry、部署 Cloud Run、处置现存消息或验证生产请求路径。5.4 后续完成情况见下方最终证据。

OpenSpec verify（版本 2，生产发布前快照）：当时任务 15/16，未完成项为 5.4 生产发布与验收。7 条 Requirement 均有源码映射；认证/模式/唤醒的既有测试与本次排空、预算、停机、文章失败阶段的新增测试覆盖合成场景。设计中的同一请求排空、固定 503、写入阶段边界与实现一致。真实单批超时、修复版云端请求和现存数据终态当时缺运行证据；最终生产验收见下方增量记录。

### 版本 2 发布后增量证据

修复镜像已推至 Artifact Registry，摘要为 `sha256:a1217104b2401a52a26beb81a96eb4872eaf9b4900ed6e4578e63b9c58ebe708`；Cloud Run 新修订版 `inbox-server-worker-00003-gut` Ready，按零流量预检后切到 100%。标签 URL 的 `/readyz` 为 200，未授权 webhook 为 401；持有效凭据的真实 webhook 返回 200，日志中多条 `worker.job.succeeded` 后才有 `worker.webhook.completed`。切流期间旧修订版在途请求完成后停止。

02:00 UTC 周期生产对账（当时状态）：Neon inbox 最终 0 行；10 条采集与 86 条分发 job 均为 `done`，本周期更新的归档 53、Cubox 43、通知 2 项效果均为 `done`。Cloudflare Queue 指标页 10:38:50 UTC+8 的 Realtime 积压为 0 消息。既有知乎 uncertain 的 job/effect 状态均保持不变、尝试次数仍为 1。过程中有即时 429，最终结算成功；Cloud Run 单批超时边界仍未实际触发。此周期的 Cron 在修复版部署前触发，不能算作发布后的第一个自然整点；当时 5.4 仍待两个后续自然整点周期。

发布后两个自然整点周期（当时的观察记录）：03:00:44 UTC 与 04:00:45 UTC 的 scheduler 记录均 `done`；相应新增的采集任务各 10 条、分发任务分别 18 与 6 条，均 `done`，Neon inbox 最终 0 行。两轮更新的归档 12、Cubox 12、通知 3 项 effect 均 `done`；Cloudflare Queue 指标页 12:05:45 UTC+8 的 Realtime 积压为 0 消息。每轮冷启动各有一次请求 503，日志见 `not_ready`，后续重投完成；无新修订版 `worker.webhook.failed` 或新 uncertain。随后完成了既有知乎 uncertain 的目标核验与单条结算，见下方；720 秒请求预算仍无真实超时证据。

### 2026-09-24 最终生产请求路径验收

- 修复版 Cloud Run 修订版 `00003-gut` 承接 100% 流量。原有 10 条到期 inbox 及 03:00、04:00 UTC 两轮自然整点均已结算；05:00 UTC 后复核的 24 jobs 全部为 `done`，Neon inbox=0、Cloudflare Queue Realtime=0。发布后观察到 12 次成功 webhook 请求，最长 157.896 秒；期间有即时 429/503，均经重试结清。这些是真实请求样本，不是极端延迟的压力证明；每个样本低于 300 秒 visibility，但单批极端慢处理及 Cloud Run 请求上限超时仍未实际验证。
- 对单条既有 uncertain 任务，先核验目标仓库 `v-yutianran/.agents` 的 `main` SHA `1ae5c6b9ba499e984152086d5e2b0f3e7d7ac0dc`；`raw/article` 与 `references/article` 固定路径的文章指纹均无匹配。归档事件 12014 为 `failed/zhihu_api_rejected`，`filename` 为空。固定范围脚本 `scripts/resolve_one_uncertain_article.py` 在真实 Neon 上 dry-run、apply 均 exit 0；DBX 独立读回确认 job=`dead`、attempts=1、failure_attempts=1、error_class=`permanent`；唯一 effect=`failed/permanent`、`finished_at=NULL`；envelope=`dead`；DLQ 仅一条、attempts=1、permanent 且 envelope 匹配；审计 worker_state 一条并记录目标 SHA 与缺失核验；inbox=0、replay_operation=0。没有自动重放，处置前状态保存在本地隔离副本 `/Users/xinwu/.backup/inbox-server-neon-d1-rollback-20260924/rehearsal.sqlite`。不记录文章标题、来源 URL 或凭据。
- 脚本 TDD：RED 用固定目标、只读 dry-run、比较并交换条件、重复/冲突前置状态和事务回滚测试约束目标行为；GREEN 后同一聚焦命令 `.venv/bin/pytest tests/unit/test_resolve_one_uncertain_article.py --tb=short -q` 为 11 passed。最新 Python 全量门禁 `.venv/bin/pytest tests/unit tests/integration -m 'not e2e' --tb=short -q` 为 310 passed / 1 skipped / 8 warnings；`.venv/bin/ruff check src/inboxserver tests scripts` 与 `.venv/bin/mypy src/inboxserver --ignore-missing-imports`（103 files）通过。`npm test` 378 passed / 9 skipped、`npm run typecheck`、`npm run build` 沿用本轮 Python 脚本前已通过的证据；本轮没有新增 TypeScript 代码。

5.4 最终结论：生产请求、队列结算、两个自然整点和单条 uncertain 目标核验/审计结算均有证据，任务已完成。此结果不证明所有未来批次都能在时限内结束；极端慢单批的取消与 Cloud Run 超时行为仍待独立压测。
