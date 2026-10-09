## 1. 设计与影响分析

- [x] 1.1 核对当前源码、主规格及 active changes，输出 proposal/spec/design，以 openspec validate 验证。
- [x] 1.2 改动前记录 GitNexus upstream impact 与 API 路由消费者；结果 UNKNOWN/partial，已以源码核对局部调用链，不将空结果当作安全证明。

## 2. RED-GREEN-REFACTOR

- [x] 2.1 RED：新增配置与 webhook 最小失败测试，运行聚焦 Vitest，确认失败来自缺少目标行为并记录命令及结果。
- [x] 2.2 GREEN：实现认证、单批执行、并发拒绝、固定错误与模式接线；同一聚焦命令通过。
- [x] 2.3 REFACTOR：复用单批执行路径，验证配置兼容及 worker typecheck/build；loop 调度接线为源码审查，未启动真实进程。

## 3. 收口与未执行边界

- [x] 3.1 执行可运行的 worker/domain 测试与项目适用门禁，更新 acceptance 的实际结果；环境拒绝不得标通过。
- [x] 3.2 写入当日 Changelog 及根索引，记录 RED/GREEN/REFACTOR、固定事件、调用步骤与云端未执行项。
- [x] 3.3 OpenSpec verify/validate 与真实 diff 审查，保留 active change 直到请求路径验证完成。

## 4. Queue 唤醒端

- [x] 4.1 改动 API 符号前运行 GitNexus upstream/API impact，核对 Queue/Cron 调用者与真实源码。
- [x] 4.2 RED：用合成 Queue、注入 fetch 测 stage→wake→ack、失败重投及 Cron 补偿，记录聚焦失败。
- [x] 4.3 GREEN：实现可选 Cloud Run 唤醒配置和最小 Queue/Cron 接线，记录聚焦通过；不写真实 D1。
- [x] 4.4 REFACTOR：运行 API typecheck/build、适用回归、OpenSpec validate 与 diff 审查，并把结果记入当日 Changelog 和验收记录。

## 验证记录

部署、真实数据库访问、Browser Run 和浏览器 E2E 均未执行。

- RED：`node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts apps/worker/tests/config.test.ts apps/worker/tests/worker-webhook.test.ts` 为 6 failed / 5 passed；失败对应尚未存在的模式、配置校验和 webhook handler。
- 首轮 GREEN：加入 queue-processor.test.ts、heartbeat.test.ts 的聚焦命令为 4 files / 22 tests passed；之后父线程审查要求补充断连后退出等待及覆盖，最终结果待记录。
- 首轮 `npm test`：API 66、Console 15、Domain 8、release-operations 30 通过；Worker 131 passed / 2 failed，health-server 与 outbound-proxy 的 socket listen 均被沙箱以 EPERM 拒绝。`npm run typecheck` 首次发现新 optional webhook 的 TS2379，交回实现修复，不作为通过。
- 最终 GREEN/REFACTOR：同四文件聚焦命令 23/23 通过；`node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json`、`node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.build.json` 通过。父线程 `npm run typecheck` 重跑通过。
- 最终 Worker 全量：`node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts apps/worker/tests`，132 passed / 2 failed；失败仍仅 health-server/outbound-proxy 监听 EPERM。一次未指定测试路径的 Vitest 调用误收集其它 workspace 并报 console/fixture 错误，不作为 Worker 门禁证据；正确指定路径后得到上述结果。
- `npm run build` exit 0，但 Wrangler 默认日志目录写入 EPERM；将日志目录设为可写临时路径后执行 `WRANGLER_LOG_PATH=/private/tmp/inbox-webhook-wrangler npm run build --workspace @inbox/api`，dry-run 构建通过，无实际部署。
- 审查：修复 PORT 仅覆盖 webhook、optional 属性类型和 SIGTERM/断连后关闭依赖前等待 active batch；main 的无轮询/heartbeat 和关闭顺序为源码核对，未冒充真实断连测试。`git diff --check` 经 git-manager 执行通过；`openspec validate add-cloud-run-worker-webhook` 通过。尚有全量门禁与真实 HTTP 验证限制，3.1 保持未完成，不归档或提交。

- GitNexus：parseWorkerConfig、run、startHealthServer、processQueueBatch 的 upstream 查询均为 UNKNOWN/partial，索引落后 1 个提交；api_impact 报 method 属性缺失。源码确认唯一批次编排为 main.ts，健康接口当前仅内部探针调用，新增 webhook 无既有调用方。
- Python 门禁（本切片实现前基线）：`.venv/bin/ruff check src/inboxserver tests scripts` 通过；`.venv/bin/mypy src/inboxserver --ignore-missing-imports` 通过（103 files，2 条既有 note）；`INBOX_DATABASE_URL='sqlite+aiosqlite:///:memory:' INBOX_MASTER_KEY='test-master-key-not-for-prod' INBOX_SCHEDULER_ENABLED=false .venv/bin/pytest tests/unit tests/integration -m 'not e2e' --tb=short` 为 264 passed / 2 failed。失败是 ps 与 fake Xvfb socket 被沙箱拒绝，不修改这些无关测试来伪造通过。

## 最终本地回归与 Queue 唤醒端证据

- API RED：`node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/tests/queue-consumer.test.ts apps/api/tests/scheduled.test.ts` 为 5 failed / 5 passed，缺 stage→wake→ack、失败重投与 Cron 补偿。URL 安全修正另有 2 个目标 RED；GREEN 后 queue-consumer 7/7，最终 `npm test` API 73/73。
- 最终 `npm test`：API 73、Console 15、Worker 144、Domain 8、release-operations 30，共 270/270；`npm run typecheck`、`npm run build` 均 exit 0。`docker buildx build --platform linux/amd64 --file Dockerfile.worker.cloud-run --tag inbox-worker:cloud-run-amd64-local --load .` exit 0，为本地构建，未推送。
- 正确项目虚拟环境 `.venv/bin/ruff check src/inboxserver tests scripts` 通过；`.venv/bin/mypy src/inboxserver --ignore-missing-imports` 通过（103 files）；合成 SQLite 环境 `.venv/bin/pytest tests/unit tests/integration -m 'not e2e' --tb=short -q` 为 266 passed、8 warnings。首次 `uv run` 误继承宿主 connector 环境并重建其 `.venv`，已在 `.learnings/errors/ERR-20260923-UVE.md` 记录，后续用仓库 `.venv/bin` 复核；connector 原环境尚未恢复核验。
- API GitNexus upstream 为 UNKNOWN/partial，源码确认 Queue/Cron 唯一生产调用者；最终合并变更 `detect_changes` 为 HIGH/11 flows，主线程复核主流程、任务处理、Queue/Cron 源码与测试，不将过期图谱当安全证明。真实 Cloud Run webhook、Browser Run、D1/Neon/Redis 与来源验收仍未执行；change 保持 active。

## 2026-09-24 生产请求路径增量证据

- Cloudflare API PostgreSQL mode 版本 `c98abb9d-c69e-4619-8a69-8c4c600a596a` 已解除迁移冻结并启用调度配置，Queue delivery 已恢复；Cloud Run worker Ready。
- 一条 Inoreader shadow 经 Queue→Neon→Cloud Run webhook→Browser Run 并成功结算，worker_jobs 状态为 done、采集 7 项、published 0。该次请求验证了真实触发路径，不代表已观察到定时触发或外部分发。

## 2026-09-24 生产 scheduler 结算增量证据

- Cloudflare API 最新版本 `536c87f8-ba9e-4ef4-9e88-b3d934db11f2` 保持 PostgreSQL backend 与 Cron `0 * * * *`。23:10 UTC scheduler job 及 10 条 collect-source jobs 全部 done；24 项分发 effects 已完成，后续 48 条 dispatch-item jobs 均 done，inbox backlog 为 0。23:20 UTC 旧十分钟周期后至 23:21:03 未见新 scheduler job。
- 该生产链路为 Queue/调度触发至 Cloud Run 的运行证据；最新每小时 Cron 的下一整点自然执行待 00:00 UTC（08:00 UTC+8），Cron 传播最多 15 分钟的边界见 [Cloudflare 官方文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

## 5. 生产验收缺陷修复（2026-09-24）

- [x] 5.1 RED：用聚焦测试复现旧批次占用新批次唤醒、请求预算耗尽和来源 API 在归档写入前失败被误报 uncertain；记录聚焦命令和目标失败。
- [x] 5.2 GREEN：在 webhook 请求内串行排空到期批次或返回可重试状态，并区分文章写入前失败与写入后结果不明；使同一聚焦测试通过。
- [x] 5.3 REFACTOR：只整理有收益的重复代码，运行 worker/API 聚焦回归、项目全量门禁、OpenSpec validate 和 `git diff --check`，将实际命令与结果记入当日 Changelog。
- [x] 5.4 生产验收：部署后只读核对 Cloudflare Queue 与 Neon inbox、这 10 条已到期消息的 job/effect 终态，以及至少两个自然整点周期；现存知乎 uncertain 先查目标端再单条处置，不自动重放。修复版 `00003-gut` 承接 100% 流量；10 条旧 inbox 与 03:00/04:00 UTC 自然周期已结算，05:00 UTC 后 24 jobs 全部 done，Neon inbox 与 Queue Realtime 均为 0。目标仓库 `v-yutianran/.agents` 的 `main` SHA `1ae5c6b9ba499e984152086d5e2b0f3e7d7ac0dc` 上，两条固定路径指纹均无匹配；单条固定范围脚本经真实 Neon dry-run/apply 与 DBX 独立读回完成审计结算，未重放。发布后 12 次成功 webhook 最长 157.896 秒；即时 429/503 经重试结清。单批极端慢处理仍未实际验证，见验收记录。

5.4 增量证据：修复版已部署并承接 100% 流量；旧 10 条到期消息及发布后 03:00、04:00 UTC 两轮自然周期均已结算，05:00 UTC 后核对的 24 jobs 全部 `done`，Neon inbox 与 Cloudflare Queue Realtime 积压均为 0。目标仓库 `v-yutianran/.agents` 的 `main` SHA `1ae5c6b9ba499e984152086d5e2b0f3e7d7ac0dc` 上，`raw/article`、`references/article` 对应指纹均无匹配；事件 12014 记录为 `failed/zhihu_api_rejected` 且 `filename` 为空。固定范围脚本的真实 Neon dry-run/apply 均 exit 0，DBX 独立读回确认 job=`dead`（attempts=1、failure_attempts=1、permanent）、唯一 effect=`failed/permanent`（`finished_at=NULL`）、envelope=`dead`、DLQ 单条且 envelope 匹配、审计记录 1 条并含目标 SHA/缺失核验；inbox 与 replay_operation 均为 0，未自动重放。修复版发布后 12 次成功 webhook 最长 157.896 秒，期间即时 429/503 经重试成功；样本均低于 300 秒 visibility，但不能证明极端慢批次不会超过 Cloud Run 请求上限。处置前状态保存在 `/Users/xinwu/.backup/inbox-server-neon-d1-rollback-20260924/rehearsal.sqlite`；详见 `acceptance.md`。

### 5.1–5.3 本地执行证据

- RED：`npm --prefix apps/worker test -- tests/worker-webhook.test.ts` 为 2 failed / 6 passed，分别复现只处理首批就返回 200 和预算耗尽仍返回 200；补充停机边界测试后 GREEN 为 9/9。预算改用单调时钟，批次间检查停机状态。
- RED：`node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts apps/worker/tests/article-archive.test.ts apps/worker/tests/job-handler.test.ts` 为 2 个目标失败 / 32 passed；补充审计事件写入异常、503 错误分类和无状态超时后，另次 RED 为 3 个目标失败 / 38 passed。GREEN 同一聚焦命令为 41/41。
- REFACTOR/回归：`npm test` 为 378 passed / 9 skipped（API 165/9、Console 15、Worker 159、Domain 9、Release Operations 30）；`npm run typecheck`、`npm run build`、`.venv/bin/ruff check src/inboxserver tests scripts`、`.venv/bin/mypy src/inboxserver --ignore-missing-imports` 均通过；合成 SQLite 环境 `.venv/bin/pytest tests/unit tests/integration -m 'not e2e' --tb=short -q` 为 292 passed / 1 skipped / 8 warnings。
- `docker buildx build --check --file Dockerfile.worker.cloud-run .` 通过；`docker buildx build --platform linux/amd64 --file Dockerfile.worker.cloud-run --tag inbox-worker:local-fix-20260924 --load .` 通过，产出本地镜像 sha256:277433e54160eb703e7f87c60ff9ef5820efc14eef10d94499d42f45278c343f；未推送或部署。`openspec validate add-cloud-run-worker-webhook` 和 `git diff --check` 通过。
- 单批无法在内部取消；720 秒预算只在批次之间生效。生产 inbox、Cloudflare Queue、来源目标端与两个自然整点周期尚未按修复版重新验收；现存 uncertain 未改写或重放。
