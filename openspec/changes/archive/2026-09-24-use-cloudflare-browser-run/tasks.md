# Tasks

## 1. 设计与影响

- [x] 1.1 核对旧 browser、main、容器及主规格，提交 proposal/spec/design/acceptance；以三个设计 Skill validate 与 `openspec validate` 检查。
- [x] 1.2 改符号前运行 GitNexus upstream impact，并以源码和调用者核对受影响流程，记录风险。

## 2. RED-GREEN-REFACTOR

- [x] 2.1 RED：加入配置、按需连接/释放与旧模式的最小失败测试，运行聚焦 Vitest 并记录目标失败。
- [x] 2.2 GREEN：实现 Browser Run CDP 连接、请求范围生命周期与可恢复失败，聚焦测试通过。
- [x] 2.3 REFACTOR：添加独立 Cloud Run 无浏览器镜像，运行聚焦测试、worker typecheck/build 与 Docker build check，确认旧镜像行为未变。

## 3. 集成与交付门禁

- [x] 3.1 运行适用全量测试、OpenSpec 验证、GitNexus detect_changes 与真实 diff 审查；记录通过/失败/受限。
- [x] 3.2 同步根和当日 Changelog，记录 RED/GREEN/REFACTOR 命令、稳定事件、未验收来源及发布阻塞。
- [x] 3.3 用授权的真实账号逐源 shadow 验收并核对 Browser Run 配额、Cloud Run 请求/租约时限。2026-09-24 七个来源逐源 shadow 完成；Inoreader 重新授权后 shadow 为 collected 7/published 0，后续 scheduler 中 Inoreader 发布 7 项、知乎发布 17 项，相关分发 effects 均为 done。Cloudflare Paid plan usage 为 0.72/10 小时、平均并发 1/10。Cloud Run 修订版 `00003-gut` 为 maxInstances=1、concurrency=1、timeout=900s；Queue visibility 为 300s。03:00 UTC 后 12 次成功请求最长 157.896s；由于 pull 与 settlement 均在请求内，该值为观察样本的 lease 时长上界，低于 300s visibility。03:00/04:00 周期均 done、Neon inbox=0；瞬时 429 和冷启动 503 均经重试结清。此项只覆盖观测样本，未验证 720/900 秒极端慢批次；既有知乎 uncertain 另行处置。完整证据及边界见 [acceptance.md](acceptance.md)。

## 验证记录

RED：`node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts apps/worker/tests/config.test.ts apps/worker/tests/browser.test.ts apps/worker/tests/job-handler.test.ts` 为 5 failed / 19 passed，目标缺口为 provider 配置、CDP helper 与批次判定。后续配置边界 RED 为 3 failed / 8 passed，覆盖远程连接超时与代理冲突。GREEN：四个聚焦文件 34/34 通过；`npm test` 全 workspace 为 API 73、Console 15、Worker 144、Domain 8、release-operations 30，全部通过；`npm run typecheck`、`npm run build` 均 exit 0。`docker buildx build --check --file Dockerfile.worker.cloud-run .` 无警告；最终 `docker buildx build --platform linux/amd64 --file Dockerfile.worker.cloud-run --tag inbox-worker:cloud-run-amd64-local --load .` exit 0，本地镜像为 linux/amd64、非 root worker、Node PID1。旧 Dockerfile 与入口脚本未修改。

GitNexus upstream 结果 UNKNOWN/partial，索引落后 1 commit；当前源码核对直接调用者。最终 `detect_changes` 对本任务与并行 webhook/API 改动合并视图为 HIGH、11 条受影响流程，主线程已检查任务处理、主流程及 Queue/Cron 调用链，不把图谱当作安全证明。Cloudflare Browser Rendering content API 对 `https://example.com/` 返回 HTTP 200 与 Example Domain，仅证明该账号服务连通；尚未运行真实 CDP、来源 shadow、镜像发布或部署。无 OTel SDK/Instrumentation，新增 CDP 边界不宣称合规。

## 2026-09-24 生产 shadow 增量证据

- Cloud Run Worker Service 为 Ready；Cloudflare Browser Run 上的 Inoreader 来源在重新授权后通过 Queue→Neon→Cloud Run→Browser Run shadow，状态 done、collected 7、published 0。该请求未验证定时调度，也未产生外部分发。
- 当时 `worker_jobs` 无直接租约取得/释放字段，创建到完成时间不足以证明租约持有时长，因此 3.3 暂未完成；后续以同一请求内 Queue pull→settlement 的成功请求耗时作为观测样本上界，补足样本验收，完整证据与极端慢批次限制见 [acceptance.md](acceptance.md)。
