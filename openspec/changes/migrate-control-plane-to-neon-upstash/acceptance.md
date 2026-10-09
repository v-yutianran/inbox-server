# 数据迁移验收

状态：进行中。生产权威数据源已切换至 Neon，常规 scheduler/worker 流量已有成功结算样本；旧 PG 的 59 条文章归档事件已完成业务身份对账，DES-007 隔离回退演练已通过。完整迁移验收仍受真实 Upstash 断网故障注入与历史异常逐项目标端核验/处置影响。

验收对象：`migrate-control-plane-to-neon-upstash` change；环境：Cloudflare API、Cloud Run worker、Neon、Upstash；核对日期：2026-09-24。需求、架构与任务基线见 [proposal](proposal.md)、[design](design.md)、[spec delta](specs/cloudflare-application-runtime/spec.md)、[tasks](tasks.md)；执行记录见[当日 Changelog](../../../docs/changelog/2026-09-24.md)。

## 验收范围

核对 D1 历史快照和旧 PG/Redis 持久卷保全、Neon 权威数据、Upstash 短期状态边界、任务处理原子性与生产切流/回退。Cloudflare 内部元数据不在范围内。

## 准入条件与退出条件

准入条件：冻结快照与旧卷归档可读、目标服务可连接、运行时凭据通过受保护路径配置。退出条件：五个用例均通过，旧源差异有可追溯终态，失败/重试不变量得到验证，隔离回退演练完成。当前 TC-004 尚未通过，退出条件未满足；真正生产回滚需另行授权，不是隔离演练的验收条件。

## 需求追踪矩阵

| 需求 | 验收标准 | 用例 | 当前结果 |
| --- | --- | --- | --- |
| REQ-001 | AC-001、AC-003 | TC-001、TC-002、TC-003、TC-004、TC-005 | D1 冻结快照已导入 Neon；旧 PG 文章归档事件业务身份已对账，全表历史状态已完成聚合与关联分类，异常逐项目标端核验/处置仍未完成 |
| REQ-002 | AC-001、AC-002 | TC-003、TC-004 | 限速状态由 Neon 持有，Upstash 用于可重建短期心跳；真实断网故障注入及遗留异常逐项目标端核验/处置未完成 |
| REQ-003 | AC-003 | TC-001、TC-002、TC-005 | 已切流并保留 D1 只读；旧源业务差异核对及 DES-007 隔离回退演练通过；真正生产回滚仍需独立授权 |

## 验收用例

| 用例 | 优先级 | 前置条件、测试数据与步骤 | 可观察的预期结果 | 执行结果与证据 |
| --- | --- | --- | --- | --- |
| TC-001 D1 冻结快照导入 | P0 | 使用最终冻结的 D1 快照；核对 23 张业务表逐表行数与内容摘要，再读 Neon 导入结果及重复导入状态。 | 冻结快照所有表的记录数与摘要一致；重复核对不产生重复记录；密文抽样可经受保护运行时路径解密。 | **通过（限 D1 快照范围）**：23 表、263,933 行的最终快照完成单事务导入并逐表核对，重复只读核对返回 `already-migrated`。之后从旧 PG 核对并另行导入的 38 条终态 `sync_jobs` 使该时点 Neon 总行数为 263,971；Inoreader 加密凭据受保护读回与输入状态一致。见当日 Changelog“冻结 D1 并将权威快照导入 Neon”“启用 Neon 控制面”。不代表旧卷全部历史已完成迁移。 |
| TC-002 旧 PG/Redis 持久卷保全与差异 | P0 | 只读读取源卷及 Neon 隔离归档；比较归档完整性，并按稳定主键和业务身份核对旧 PG 与 D1 差异。 | 两份原始卷可恢复；差异有计数及处置状态，不覆盖 Neon 权威行。 | **通过（差异核对范围）**：旧 PG 与 Redis 归档已完成只读完整性核验。旧 PG 归档的 1,826 条 `article_archive_events` 与冻结 D1 快照按 `source_url`、`url_fingerprint`、`title`、`status`、`reason`、`filename`、规范化 UTC 微秒 `occurred_at` 构成的无序多重集合完全一致；59 个旧 PG 独有 ID 均在 D1 找到相同业务行，差异仅为 ID 重排。旧格式记录与当前 Neon 的同范围只读复核也完全一致，59/59 个来源身份匹配；另有 38 条旧 PG 终态 `sync_jobs` 已单独导入。源归档保留只读；临时容器与目录已清理，源 tar 清理后 SHA-256 与 manifest 一致。核对记录见当日 Changelog“核对旧 PG 归档事件与 Neon 业务身份”。 |
| TC-003 未知 Redis 队列项安全处置 | P0 | 从只读 Redis 卷归档核对 35 项；与 Neon 现行任务/effect 去重状态比对，确认未知项没有进入活动队列。 | 已完成项不重复产生副作用；身份不明项保持可恢复且不自动重放；人工处理状态单独列明。 | **通过（迁移安全边界）**：35 项原始记录已完整归档；2 项核对为已有完成记录；其余 33 项按用户决定写入 IMA 笔记 `7508691314025748`，读回核对 33/33 项的去重键、原始记录摘要与来源信息；未激活或重放。后续人工业务处理属于交接后的事项，不阻塞本次迁移安全验收，也不代表目标端业务已完成。证据见当日 Changelog“将旧 Redis 的 33 条待处理项交接到 IMA”。 |
| TC-004 事务、并发、故障与重试 | P0 | 在隔离 PostgreSQL 运行租约、重复入站、失败回滚及重试聚焦测试；读取生产 inbox/jobs/effects；验证 Upstash 失效回退。 | 事务无部分提交，Queue 重投后结算；临时状态服务失败不丢失已接收任务；异常项有可追溯终态。 | **进行中**：本机 PostgreSQL 并发/事务聚焦测试 14/14 通过；部署后的 429 与冷启动 503 经 Queue 重投后观察到结算，05:00 UTC 后核对的 24 jobs 均为 `done`。合成聚焦命令 `node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/tests/heartbeat-cache.test.ts apps/api/tests/control-plane-postgres-data.test.ts apps/api/tests/operations-readiness-postgres.test.ts` 为 3 files/21 tests passed，覆盖 REST 失败 best-effort、TTL 过期及旧缓存回源 Neon。真实 Upstash 验证中，受保护的 REST `PING` 返回 HTTP 200/PONG；故意使用无效 token 执行 `GET` 返回 HTTP 401 后，`readLatestWorkerHeartbeat` 记录 `upstash.heartbeat_cache.failure`（`operation=get`、`reason=http`），并返回与 Neon `READ ONLY` 事务只读查询一致的 `worker_id`/`last_seen_at`。另以随机 acceptance namespace key 执行不存在预检、`SET ... EX 60`、`GET`、`TTL`、`DEL` 和删除后复核；测试键最终不存在，生产 heartbeat key 未触碰。此验证没有注入真实网络断连。相对冻结 D1，Neon `worker_jobs` 当前为 dead=6,867/done=82,674/failed=1/uncertain=2,913，基线为 dead=6,866/done=82,248/failed=1/uncertain=2,913；`worker_inbox=0`，DLQ=6,881（基线 6,880），replay=0。所有 6,867 条 dead jobs 均关联 DLQ；2,913 条 uncertain jobs 均无 DLQ/replay，其中 2,862 条有关联 envelope、51 条无 envelope。`worker_effects` 当前为 done=12,121/failed=1/processing=130/uncertain=2,966；冻结 D1 对应 done=11,782/processing=130/uncertain=2,966。effects 的冻结分组依据 `updated_at`，done 分组的 339 条净增不能解释为新建记录；可确认的是 uncertain/processing 异常计数未增。2,966 条 uncertain effects 中，2,913 条关联 uncertain jobs、53 条关联 dead+DLQ；130 条 processing effects 中，126 条关联 dead+DLQ、4 条关联 done。此次已安全处置的知乎项表现为 job=`dead`、effect=`failed`、envelope/DLQ 一致；另有 `worker_jobs.failed=1` 已存在于冻结快照、无 DLQ 且 `finished_at=NULL`，不是本次新增或已处置项。历史 uncertain/processing 项仍缺逐项目标处置，且没有真实 Upstash 断网故障注入，因此保持进行中。证据见当日 Changelog“验证 Upstash 真实端点回退与历史状态”。 |
| TC-005 生产切流、观察与回退演练 | P0 | 确认 API 使用 PostgreSQL、D1 保持只读；读取自然调度、Queue→Cloud Run 请求与 Neon 结算；按 design DES-007 从冻结 D1 快照及 Neon 数据构造隔离 SQLite 副本，核对数据与 D1 读取契约。 | 真实新流量在 Neon 正常结算；回退副本逐表内容、完整性和外键核对通过；不直接将旧 D1 切回权威。 | **通过（切流观察与隔离演练范围）**：Cloudflare API 已运行 PostgreSQL 模式并关闭冻结，D1 保留只读；Cloud Run 修订版 `00003-gut` Ready。自然周期、发布后 24 jobs 及 webhook 重试后的结算均有证据，Neon inbox 与 Queue Realtime 均为 0。DES-007 演练 dry-run exit 0（23 表、未创建输出），apply exit 0（23 表、265,120 行）；副本权限 0600，`integrity_check=ok`、`foreign_key_check=0`；源快照前后校验一致。使用 D1 测试适配器与 `createD1OperationsReadinessService.getQueueSummary()` 对隔离副本只读核对，无外部副作用；副本捕获较早时点的 10 条 leased inbox（processing），之后真实 Neon 只读复核为 0，证明副本不能直接作为当前回切权威副本。最长观测 webhook 为 157.896 秒，低于 300 秒 Queue visibility；未覆盖极端慢单批。未执行生产回滚；按 DES-007，实际回滚需另行授权，先冻结 Neon 写入并核对最后增量。逐表报告见受限报告 `/Users/xinwu/.backup/inbox-server-neon-d1-rollback-20260924/REPORT.md`；生产观察见当日 Changelog“完成 webhook 修复版最终生产验收”，副本只读读取结果见“完成 Neon 到 D1 的本地隔离回退演练”。隔离容器与目录已清理，源 tar 清理后 SHA-256 与 manifest 一致。 |

### TC-002 后续容量整理状态（2026-09-24）

- TC-002 的原通过结果记录迁移时点的归档与差异核对。之后已确认本机受限 tar 的文件大小和 SHA-256 与清单一致，并检查实际隔离恢复记录 `/Users/xinwu/.backup/inbox-server-legacy-volumes-2026-09-24/REPORT.md`。旧卷的当前恢复来源为该本机 tar。
- Neon `inbox_server_legacy.volume_archives` 两行 BYTEA 原始字节已按精确值删除，空表已 `TRUNCATE`；当前表为 0 行、结构保留。因此 Neon 不再保存旧卷原始字节。该 tar 是本机副本，未证明存在异地备份，不能称为异地备份。旧 PG 内容对账及 Redis 33 项 IMA 人工交接结论不变。

### TC-004 本轮核验补充

- 隔离 loopback `ECONNREFUSED` 测试触发 `upstash.heartbeat_cache.failure`（`operation=get`、`reason=request`），随后从 Neon `READ ONLY` 事务回源；heartbeat 的 `worker_id`/`last_seen_at` 与 Neon 直接只读查询一致。该结果证明客户端处理连接拒绝时的回源路径，不代表 Upstash 服务商真实宕机，真实服务商网络故障注入仍未完成。
- Neon 与冻结 D1 的历史异常 effect 关联分组共 8 组，逐组分布一致。固定目标仓库 `main` 快照 `f052fc76dafe93f16fdb9c7a860e40271b3fcaea` 下的 2,955 条 article effects 按 URL 指纹核对：uncertain 为匹配/缺失/无效 `1,729/1,181/2`，processing 为匹配/缺失/无效 `3/39/1`。目标快照共 6,628 篇 Markdown、URL 无重复；临时 clone 已清理。Markdown 指纹存在仅证明目标内容存在，不能证明对应 effect 的特定投递已成功；未匹配项也不授权自动重放。数据库状态未修改。
- Cubox 只读核验本轮已停止：已认证读取首页 50 条，返回 `has_more=true`；Neon 使用 asyncpg 只读事务 COUNT 确认 Cubox uncertain/processing effects 共 131 条。客户端请求/临时子进程故障导致完整分页未取得有效全量页，目标 present/missing 结果未知；首页 50 条未当作匹配结果。无数据库或 Cubox 写入，也未输出或保存业务内容。Flomo 与 notification 仍无可靠目标端 effect 回执。历史异常的逐项目标端核验与安全处置仍未完成，TC-004 继续进行中。

## 执行记录与未执行项

- 生产状态已由“Neon 空业务库、API 未部署/未切流”的早期阶段推进为 Neon 承载权威业务数据、API PostgreSQL 模式运行且 D1 只读保留。早期 Changelog 段落描述其记录当时的时间点，不作为当前状态。
- 2026-09-24 容量整理后，旧卷恢复来源为本机受限 tar，Neon 归档表为空且保留结构；依据、文件完整性及隔离恢复证据见上方 TC-002 后续状态。4.8/4.10 所记 DBX free 分组下 Neon 月存储占用率 89.8% 是较早控制台读数，本轮未重新核对当前比例。
- 03:00、04:00 UTC 自然周期及 Cloud Run 请求样本已有真实结算证据；一次请求耗时上界样本不证明极端慢批次一定能在 900 秒内安全完成，也不证明回退成功。
- 未完成：遗留 uncertain/processing 异常的逐项目标端核验与处置；真实 Upstash 不可用的网络断连故障注入。生产回滚与冻结 Neon 后的最后一致快照需另行授权和执行，不是已完成的隔离演练条件，也不因此把本次回退演练判为未通过。TC-004 中的一条新知乎 uncertain 已完成目标端指纹核验与安全终态处置，未重放；旧 Redis 33 项已按用户决定完成 IMA 交接，未来人工业务处理不作为本次迁移的未完成项。
- 本次验收文档更新未执行生产回退、数据修改或重放旧队列项；既有迁移写入仅按当日 Changelog 所述记录。本次未触发云端写入。
- GitNexus 已以 `--index-only` 刷新至 HEAD `41d2ece`；`detect_changes(scope=all)` 报告 `changed_count=104`、`affected_count=34`、`changed_files=39`、risk=`critical`，其中未跟踪文件仍需人工复审。`git diff --check` exit 0 不替代影响审查，因此 tasks 5.2 保持未完成。
- D1 快照迁移测试本轮新增有效谓词 schema 不变量 RED，修复后 11 passed；合成夹具覆盖 23 表、任意 `worker_state` key、凭据密文字节、主键与幂等重导入。此前夹具缺表的失败仍仅作为无效 RED 历史记录。旧 `sync_jobs` 幂等重跑测试 GREEN 为 16 passed；真实冻结 D1→当前 Neon 的只读 dry-run 在 schema 校验后因目标含后续生产数据而以 `target contains different non-empty data` 安全拒绝，未 apply，故不宣称本轮导入完成。

## 残余风险与验收结论

DBX free 分组对应的 Neon Free Plan 月存储额度曾显示使用率 89.8%；该比例属于较早读数，当前控制台比例未复核，需重新核对后再判断余量。Cloud Run 单个批次不可中断；最长 webhook 观测为 157.896 秒，但未覆盖极端慢单批，仍存在逼近平台超时的风险。全表异常计数及关联已完成聚合分类，但遗留异常尚未逐项目标端核验和处置，因此不能把“Neon 当前收件箱为空”解释为“全部历史业务记录已解决”。

Worker diff 只读审查另发现 MEDIUM readiness 风险：`apps/worker/src/main.ts:174` 的 webhook 模式不写 heartbeat，而 `apps/api/src/operations-readiness-postgres.ts:259` 在 90 秒后将其判为过期，活动中的按需 worker 也可能报告 `heartbeat_stale/degraded`。Webhook OpenSpec 明确空闲时不发周期 heartbeat；修复前须定义 idle/triggerable 与活动期间的心跳契约，并覆盖 PostgreSQL/D1 readiness 和 metric。当前未修复。该审查 8 files/73 Vitest 通过；GitNexus impact 为 partial/UNKNOWN 且无 PDG，通知 provider 失败被吞为既有语义，不属于本次 diff 回归。

旧 `sync_jobs` 补入仅完成脚本级幂等性验证。真实冻结 D1 到当前 Neon 的只读 dry-run 因目标存在迁移后生产数据而停止；是否对该非空差异另行建立安全核对/补入方案仍未解决，不能把脚本测试结果当作真实数据已导入。

**验收结论：进行中，不得宣称整体迁移完成。** 已有证据支持 D1 冻结快照导入、旧卷保全及业务身份核对、生产切流、新流量的有限运行样本和 DES-007 本地隔离回退演练。遗留异常逐项目标端核验/处置与真实 Upstash 断网故障注入仍缺证据；真实生产回滚属于独立授权动作，不是本地演练的验收结论。

## 覆盖统计

5 个 P0 用例：4 项通过（TC-001、TC-002、TC-003、TC-005）；1 项进行中（TC-004）。REQ-001、REQ-002、REQ-003 均已映射验收标准、用例和执行证据；整体迁移仍未达到退出条件。
