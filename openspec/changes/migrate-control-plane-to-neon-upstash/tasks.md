# Tasks

## 1. PostgreSQL 结构与连接

- [x] 1.1 RED：用空库与样本主键写失败测试覆盖 23 张业务表、约束、bytea 与重复迁移；运行聚焦测试并记录目标失败。首次聚焦测试因迁移文件缺失按预期失败；本机 PostgreSQL 17.6 复核 23 表、52 索引、BIGINT/BYTEA 样本及重复执行，详见当日 Changelog。
- [x] 1.2 GREEN：实现独立 `inbox_server` PostgreSQL schema、版本化迁移及 Hyperdrive 连接；同一聚焦测试通过，迁移不改动 `public`。本机迁移重复运行通过；Neon 23 张空业务表与 1 条版本记录读回通过；API 接线测试 6/6、typecheck/build 通过。尚无正式 Hyperdrive 绑定。
- [ ] 1.3 REFACTOR：仅整理有收益的重复 SQL/连接生命周期；重跑聚焦测试、API typecheck/build，并在当日 Changelog 记命令和结果。

## 2. 权威仓储替换

- [ ] 2.1 RED：用并发与失败注入测试复现 inbox 入站/租约/结算和 Queue ack 顺序；运行聚焦测试确认目标失败。
- [ ] 2.2 GREEN：将 inbox 读写改为 PostgreSQL 条件更新和事务；同一测试通过，故障时 Queue 不 ack。
- [ ] 2.3 RED：为 claim/finish/effect/死信重放与凭据 BLOB 增加跨表事务和重复投递失败测试；运行聚焦测试确认目标失败。
- [ ] 2.4 GREEN：将控制面改为 PostgreSQL 单连接事务，保留现有领域策略及 HTTP 契约；同一测试通过。
- [ ] 2.5 RED/GREEN：按聚焦失败测试迁移运维、快照、状态与历史读写；覆盖 23 张表的运行时路径和缺席 Redis 时的恢复。
- [ ] 2.6 REFACTOR：整理仅有收益的重复代码；运行 API 全量测试、typecheck/build，并在当日 Changelog 记录 RED/GREEN/REFACTOR 证据。

## 3. Upstash 短期状态

- [ ] 3.1 RED：添加 Redis 断连/过期的心跳缓存测试，证明任务和历史仍由 Neon 恢复；运行聚焦测试确认目标失败。
- [ ] 3.2 GREEN：接入 Upstash REST Secret 与带 TTL 心跳缓存，保留 PostgreSQL 限速原子性；同一测试通过。
- [ ] 3.3 REFACTOR：重跑聚焦测试及 API 全量门禁，在当日 Changelog 记录实际结果。

## 4. 全量数据导入与切流

- [x] 4.1 RED：使用合成 D1 快照验证 23 表、任意 `worker_state` 键、密文、主键及幂等重复导入；运行聚焦测试确认目标失败。本轮有效 RED 针对 partial unique predicate schema 不变量，覆盖字面量空格/大小写、quoted identifiers 与括号差异；修复前有 2 个目标行为失败，括号用例也触发目标 RED。GREEN 后 `uv run pytest tests/unit/test_migrate_d1_snapshot.py --tb=short` 为 11 passed，全仓 `uv run ruff check src/inboxserver tests scripts` 通过。此前合成夹具缺少 `worker_state` 而报 `no such table` 仍是无效夹具失败，不作为本项 RED 证据。
- [ ] 4.2 GREEN：实现只读 D1 导出、隔离 schema 导入、逐表行数/主键摘要/关联与解密抽样核对；同一测试通过且预检零写入。
- [ ] 4.3 REFACTOR：运行合成并发/失败/回退演练与全量门禁，记录 Changelog；任何不变量失败保持旧路径。
- [x] 4.4 只读归档旧 PG/Redis 持久卷并与 D1 初步对账；验证源/归档 SHA-256、旧 PG 主键差异和 Redis 队列基数。已确认 97 个旧 PG 独有主键、35 个覆盖未知的 Redis 队列元素；报告保存在受限备份目录。
- [x] 4.5 RED：用合成旧卷归档测试默认只读、来源固定、字节摘要、重复导入及内容冲突拒绝；确认目标行为失败。Python 因模块缺失、迁移 Vitest 因 0002 缺失按预期失败。
- [x] 4.6 GREEN：将两份源卷归档原始字节保存到 Neon 隔离结构，写后回读校验来源、字节数与 SHA-256；不覆盖 D1 权威行，不消费或重放队列。本机 PG 7/7 与迁移 2/2 通过；真实归档 dry-run、Neon 0002 事务回滚预演、正式导入及 DBX 独立读回两行通过，23 张业务表仍为空。
- [x] 4.7 核对旧 PG 与 D1 的业务身份及旧 Redis 队列项的终态；无法证明等价的项目保留归档并在验收报告中列为未激活，验证差异清单无遗漏。旧 PG 独有 38 条终态 sync_jobs 已核对后导入；Redis 35 条原始队列完整归档。逐项重读、现行 Schema/去重校验与 Neon 对账确认 2 条已有完成记录，其余 33 条已写入 IMA 笔记 `7508691314025748` 交接人工处理并读回核对；未激活或重放。
- [x] 4.8 获取运行时凭据并核对服务商额度、真实 D1 当前行数和一致快照；验证备份校验值与隔离试迁报告。运行时凭据、D1 冻结行数与快照一致性、备份 SHA-256 和隔离试迁报告均已核验。Neon `dbx-postgres18/production` 控制台显示 Free Plan、每项目 0.5 GB storage allowance，monthly storage allowance 已用 89.8%；Overview 分别显示 Storage 237.57 MB、History 259.67 MB，口径不同不相加，额度余量偏紧。
- [x] 4.9 冻结旧写入、导入完整快照与旧卷差异并完成逐表核对、shadow、回退演练；以可定位报告验证，失败则不切流。冻结快照、全表导入核对及一条无外部分发 shadow 已通过。DES-007 本地隔离回退演练 dry-run exit 0（23 表，未创建输出），apply exit 0（23 表、265,120 行）；输出权限 0600、`integrity_check=ok`、`foreign_key_check=0`；随后通过 D1 测试适配器与 `createD1OperationsReadinessService.getQueueSummary()` 对本地副本只读核验，未产生外部副作用。旧 PG 归档 1,826 条 `article_archive_events` 与冻结 D1 快照按七个业务字段规范化 UTC 微秒后多重集合完全一致；59 个 PG 独有 ID 的业务行全部在 D1 找到，仅 ID 重排。当前 Neon 只读复核又确认旧格式 1,826 条记录内容多重集合一致，59/59 个旧 ID 对应的来源身份存在；旧 PG 38 条终态 `sync_jobs` 已单独导入。生产回滚未执行，依 DES-007 需另行授权并先冻结 Neon 写入、核对最后增量，不属于本地隔离演练的退出条件。源归档仍只读；临时容器与目录已清理，源 tar 清理后 SHA-256 与 manifest 一致。受限逐表报告见 `/Users/xinwu/.backup/inbox-server-neon-d1-rollback-20260924/REPORT.md`。
- [x] 4.10 配置 Cloudflare Hyperdrive/Upstash Secret 并切流，验证真实 API、Queue→Cloud Run 单批次、凭据解密及外部副作用；保留 D1 只读回退源。切流与 Inoreader 凭据解密已验证；23:10 UTC scheduler job 与 10 条 collect-source jobs 全部 done，24 项分发的 Cubox/article archive effects 各 24 条及 notification effects 2 条均 done，48 条 dispatch-item job done、inbox backlog 0。23:20 至 23:21:03、23:30:08 UTC 两次只读核查均未见旧周期之后的新 scheduler job。最新部署 `536c87f8-ba9e-4ef4-9e88-b3d934db11f2` 保留每小时 Cron 并启用 PostgreSQL；D1 保留只读。Neon Free Plan 已核验、monthly storage allowance 使用率 89.8% 且余量偏紧。该时点后续自然整点运行见当日 Changelog“每小时 Cron 与真实 scheduler 结算增量证据”；DES-007 隔离回退演练见 4.9。
- [x] 4.11 2026-09-24 后续容量整理：复核本机受限 tar 的文件大小及 SHA-256 清单，并核对已有隔离恢复报告 `/Users/xinwu/.backup/inbox-server-legacy-volumes-2026-09-24/REPORT.md`；随后从 Neon 按精确 BYTEA 值删除旧归档两行，对已空表执行 `TRUNCATE`，确认 `inbox_server_legacy.volume_archives` 为 0 行且结构保留。当前恢复来源为本机受限 tar，未证明存在异地备份；旧 PG 内容对账与 Redis 33 项 IMA 人工交接不变。4.8/4.10 所记 DBX free 分组下 Neon 月存储占用率 89.8% 属较早读数，本轮未复核当前控制台比例。

## 5. 收口

- [x] 5.1 运行 `npm test`、`npm run typecheck`、`npm run build`、适用 Python 检查及 `openspec validate migrate-control-plane-to-neon-upstash`；逐项记录结果。正式切流前的阶段性门禁为 TypeScript 330 passed/9 skipped、Python 280 passed/1 skipped，本机 PG 聚焦 14/14 通过；2026-09-24 切流后最新门禁及只读状态复核见下方增量证据。
- [ ] 5.2 用 GitNexus `detect_changes` 与当前源码审查影响和真实 Git diff，完成验收文档证据及当日 Changelog；未通过项保持未完成。

## 2026-09-24 生产切流增量证据

- Neon：D1 冻结快照 263,933 行，加上核对后补入的旧 PG 独有 38 条 sync_jobs，共 263,971 行；38 条导入摘要与隔离 dry-run 一致（`d700796dbc559d990fc1e0ac7ce71b82436f54443f75249296062d737c8a9f13`）。
- 旧 Redis 的 35 条 pending/dead-letter 原始项仍完整保存在归档，2 条已有完成记录，33 条已交接人工处理，未进入活动队列。用户授权的 Inoreader StorageState 经 worker-token 保护接口加密写入 Neon，授权读回与来源状态逐字一致，共 16 cookies；不记录凭据内容。
- Cloudflare API PostgreSQL 模式部署版本 `c98abb9d-c69e-4619-8a69-8c4c600a596a` 已关闭迁移冻结并启用定时配置，Queue delivery 已恢复。Cloud Run worker 状态 Ready。一条 Inoreader 无外部分发 shadow 经 Queue→Neon→Cloud Run→Browser Run 完成，worker_jobs 终态 done、collected 7、published 0。
- 在该阶段切流时尚未观察到定时任务自然触发，Neon 实际额度与真实分发结果也尚未核验；后续生产 scheduler 运行与结算见“2026-09-24 每小时 Cron 与真实 scheduler 结算增量证据”，Neon 额度见“Neon 免费额度只读复核”。该段保留当时状态，不覆盖后续证据。
- 最新门禁：`npm test` 为 API 165 passed/9 skipped、Console 15、Worker 152、Domain 9、Release Operations 30，共 371 passed/9 skipped；`npm run typecheck` 与 `npm run build` 通过。Python ruff、mypy（103 files）通过，pytest 为 292 passed/1 skipped/9 warnings；`git diff --check` 通过。
- 切流后只读复核：D1 `worker_jobs=92028`，与冻结快照一致；Neon `worker_jobs=92029`，含新增 shadow job；Cloudflare Queue 实时积压为 0。以上不代表已观察到定时任务触发。

## 2026-09-24 Upstash 实时端点回退与历史状态复核增量证据

- 使用 `node --input-type=module` 和 `node --import tsx --input-type=module` 内联验证；PostgreSQL 使用 `READ ONLY` 查询，Redis 仅写入并删除随机 acceptance namespace 验收键。GCP Secret Manager 版本由 Node `child_process` 在进程内读取，没有写入凭据文件或保存可复跑脚本。受保护 Upstash REST `PING` 返回 HTTP 200/PONG；故意使用无效 token 的 `GET` 返回 HTTP 401，`readLatestWorkerHeartbeat` 记录 `upstash.heartbeat_cache.failure`（`get`/`reason=http`），并从 Neon 只读事务返回与 SQL 读回一致的 `worker_id` 和 `last_seen_at`。真实网络断连未注入。
- 随机 acceptance namespace key 生命周期验证：先确认不存在，再执行 `PING`、`SET ... EX 60`、`GET`、`TTL`、`DEL`、删除后 `GET`，验证键值、TTL 和最终不存在；没有触碰生产 heartbeat key。DBX 保存的 PostgreSQL/Redis 凭据分别返回认证错误 `28P01`/`NOAUTH`，本次用受保护直接连接完成核验。
- 冻结 D1 与当前 Neon 只读聚合：jobs 的 dead/done/failed/uncertain 分别为 `6,866/82,248/1/2,913` 与 `6,867/82,674/1/2,913`；effects 当前 done/failed/processing/uncertain 为 `12,121/1/130/2,966`，冻结 D1 对应 done/processing/uncertain 为 `11,782/130/2,966`。effects 按 `updated_at` 分组，不能把 done 分组净增解释为新建行；已确认 uncertain/processing 异常计数未增加。Neon `worker_inbox=0`、DLQ `6,881`（D1 `6,880`）、replay `0`；dead jobs 全部关联 DLQ。历史 uncertain/processing 仍未逐项闭环，故这组证据不改变 3.1–3.3 的 RED/GREEN 任务状态或整体验收结论。

## 2026-09-24 每小时 Cron 与真实 scheduler 结算增量证据

- Cloudflare API 版本 `4e938058-2802-40b7-8d64-606775c3df5b` 首次部署 Cron `0 * * * *`；最新版本 `536c87f8-ba9e-4ef4-9e88-b3d934db11f2` 保留该配置及 PostgreSQL backend、`SCHEDULE_ENABLED=true`，并将运维概览统一为 3600 秒、对齐下一 UTC 整点。23:10 UTC scheduler `sync_job`、10 条 collect-source jobs 均为 `done`；Inoreader 7 项和知乎 17 项均已发布。24 个 item 的 Cubox 与 article archive effects 各 24 条 done，notification effects 2 条 done；后续 48 条 dispatch-item jobs done，未发现 processing/failed/dead/deferred/uncertain 状态，inbox backlog 为 0。
- 23:20 UTC 旧十分钟周期后至 23:21:03 UTC 未新增 scheduler job；23:30:08 UTC 复查自 23:20 UTC 起仍未新增。最新每小时 Cron 首个预期触发时间 00:00 UTC（08:00 UTC+8）尚未到达。Neon 额度在该时间点尚未核验，后续 UI 读回见“Neon 免费额度只读复核”；D1 回退演练仍未验证。Cloudflare 官方说明 Cron 变更最多需 15 分钟传播。
- 运维概览 RED 3 项失败、GREEN 19 项通过；`npm test` API 为 165 passed/9 skipped、全仓 TypeScript 371 passed/9 skipped，`npm run typecheck` 与 `npm run build` 通过。
- 验证：`node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/tests/scheduled.test.ts apps/api/tests/postgres-wiring.test.ts` 14/14 通过；`npm run build --workspace @inbox/api` Wrangler dry-run 通过。

## 2026-09-24 TC-004 与验收收口补充

- 隔离 loopback `ECONNREFUSED` 测试令 `readLatestWorkerHeartbeat` 记录 `upstash.heartbeat_cache.failure`（`operation=get`、`reason=request`），随后以 Neon `READ ONLY` 事务回源；返回的 heartbeat 与 Neon 直接查询一致。该结果不代表 Upstash 服务商宕机，真实服务商网络故障注入仍未完成。
- Neon 与冻结 D1 的历史异常 effect 关联分组共 8 组，逐组一致。目标仓库 `main` 快照 `f052fc76dafe93f16fdb9c7a860e40271b3fcaea` 有 6,628 篇 Markdown 且 URL 无重复；对 2,955 条 article effects 做 URL 指纹核对，uncertain 匹配/缺失/无效 `1,729/1,181/2`，processing 匹配/缺失/无效 `3/39/1`。临时 clone 已清理；存在只证明目标内容匹配，不能证明该 effect 的特定投递成功，缺失也不授权重放。未改动数据库状态。Cubox 只读核验本轮已停止：已认证读取首页 50 条，`has_more=true`；Neon asyncpg 只读事务 COUNT 得 Cubox uncertain/processing effects 共 131 条。客户端请求/临时子进程故障导致完整分页未取得有效全量页，present/missing 未知，首页 50 条未作为匹配结果；无数据库或 Cubox 写入，也未输出或保存业务内容。Flomo/notification 暂无可靠 effect 回执。
- GitNexus `--index-only` 已刷新至 HEAD `41d2ece`；`detect_changes(scope=all)` 为 `changed_count=104`、`affected_count=34`、`changed_files=39`、risk=`critical`，未跟踪文件仍待人工复审。`git diff --check` exit 0；因此 5.2 仍未完成。

## 2026-09-24 同步任务幂等重跑补充证据

- `scripts/migrate_legacy_sync_jobs.py` 聚焦测试 RED 为 2 failed/2 passed，GREEN 后 16 passed，Ruff 通过：完全相同候选返回 `already-migrated`；部分或不同内容拒绝写入；dry-run 零写入。
- 对冻结 D1 与当前 Neon 执行真实只读 dry-run：目标 schema 校验通过后因 Neon 已含后续生产数据而返回 `target contains different non-empty data`。这是对不同非空目标的预期拒绝，不代表导入通过；未执行 apply，数据库未改动。
- 收口门禁：`uv run pytest tests/unit tests/integration -m 'not e2e' --tb=short -q` 为 317 passed/1 skipped/9 warnings；全仓 `uv run ruff check src/inboxserver tests scripts` 通过；`uv run mypy src/inboxserver --ignore-missing-imports`（103 files）通过。
