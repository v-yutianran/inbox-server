# Tasks

## 1. 跨实例完成状态

- [x] 1.1 RED：新增跨实例共享状态及状态写拒绝用例，执行 `npm run test --workspace @inbox/worker -- tests/ima-article-mirror.test.ts`，16:27 首轮 states.size=0 失败，原 9 项通过。
- [x] 1.2 GREEN：复用 WorkerControlPlane getState/putState，webhook 接入；同一聚焦命令 16:28 10/10 通过，旧文件标记测试不变。
- [x] 1.3 REFACTOR：核对最小 diff，聚焦测试保持通过；命令/结果写入当日 Changelog。

## 2. 自动月份目录

- [x] 2.1 用户回复继续后核对当前 ima 网页建目录协议，更新 design.md；目标根完整分页无 202610，原生 HTTP 官方网页读请求 HTTP 200/code 0。ads2 原有窗口保留，单窗口。
- [x] 2.2 RED：新增缺失月份创建、已存在不创建、冲突和创建失败用例；`npm run test --workspace @inbox/worker -- tests/ima-article-mirror.test.ts tests/config.test.ts` 16:35 4 项因未创建/未解析配置失败；16:45 加入网页/OpenAPI 不同 ID 回归，4 项按请求使用错误 ID 或缺字段失败。
- [x] 2.3 GREEN/REFACTOR：最小目录创建实现，经独立列表读回后上传；同一聚焦命令 16:46 27/27 通过，旧无网页凭据模式保留；记录 Changelog。

## 3. 门禁与生产恢复

- [x] 3.1 `npm test` 388 passed/9 skipped；`npm run typecheck`、`npm run build` 通过；Python ruff/mypy 通过、非 E2E tests 318 passed/1 skipped/8 warnings。网页/root ID 修正后 Worker 167/167、全仓 test/typecheck/build 最终再通过；Python 未改动，复用已通过结果。
- [x] 3.2 完成只读预检并保存 600 配置/Secret/service 可校验备份，复用本机 ima 凭据到版本 3；读回摘要相等、网页目标名称匹配，旧生产固定版本 1 保留；版本 2 未挂载到生产。
- [x] 3.3 完整编译当前源码并经 crane 发布不可变镜像，读回摘要相等；无流量 revision ima-archive-1009 健康通过，实际挂载 Secret 3；双认证/目标预检后切换 100% 流量。目录按 design.md 由首篇真实文章创建。
- [x] 3.4 用户明确授权后核验 ads2 Inoreader 登录，导出仅该站点会话、备份旧配置和凭据并调用已有加密导入接口，规范化 JSON 独立读回相等；保留增量 baseline。
- [x] 3.4a 真实运行复现根目录空 ID 返回 code 51；17:28 RED 聚焦测试 3 failed/12 passed，17:29 GREEN 27/27，Worker 全量 167/167、typecheck/build 通过；重新发布 ima-root-1009、不可变镜像和实际 Secret 3 读回正确、tag readyz 200 后切流 100%，主地址 readyz 200。
- [x] 3.5 正常 Inoreader 增量采集成功；本次 4 篇建目录失败经独立对账和 dry-run、用户明确授权后仅补镜像，同镜像 Cloud Run Job Completed=True，4 次镜像成功；唯一 202610、正文 4/4、持久标记 4/4、对账状态读回通过。另一镜像实例使用真实完成标记跳过 4 篇，ima/COS 请求 0；保留原 uncertain 审计，未重放队列。
- [x] 3.6 用 openspec-verify-change 对照实现，3 个 Requirement/6 个 Scenario 覆盖，无 CRITICAL/WARNING；`openspec validate restore-cloud-run-ima-archive`、三设计文档校验、GitNexus detect_changes 和 git diff --check 完成。HIGH 风险已报告并用真实 diff 核对；当日 Changelog 与验收记录完成，精确本地提交按已全绿范围执行，不 push/PR。
