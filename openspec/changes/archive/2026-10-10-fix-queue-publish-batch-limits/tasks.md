# Tasks

## 1. RED

- [x] 1.1 添加数量、UTF-8 大小、超大消息和后续批次失败回归；执行 `npm run test --workspace @inbox/api -- tests/queue-producer.test.ts`，09:18:46 为目标行为 5 failed / 4 passed，已记录 Changelog。

## 2. GREEN / REFACTOR

- [x] 2.1 最小实现公共生产者顺序分批，同一聚焦命令 09:19:10 为 9/9 通过；复核无新依赖、消息结构或幂等键变化，REFACTOR 无必要额外整理。
- [x] 2.2 `npm test` 396 passed / 9 skipped，`npm run typecheck`、`npm run build`、ruff、mypy、`git diff --check` 均通过；Python 非 E2E 318 passed / 1 skipped。

## 3. 部署与真实验证

- [x] 3.1 同配置 Wrangler dry-run 后部署 inbox-server-api，版本 ebcae9e9-fd19-462d-900d-9f455df235b0，100% 流量、原绑定及配置读回一致，真实 publish HTTP 200。
- [x] 3.2 正常 dida 采集在 09:55:33 完成，attempts=1、settlement=ack；原 226 条链接任务全部消失、68 条普通待办全部保留，223 条去重链接 Cubox effect 全部 done，备份 SHA256 不变。
- [x] 3.3 当日 Changelog 与索引已更新；OpenSpec verify 的 2 条 Requirement/7 个 Scenario 均有实现及验证证据，validate/diff check 通过；GitNexus detect_changes low（旧索引不完整），精确 Git diff 无无关实现，文档 audit 无错误、8 个既有警告。最终 npm test 399 passed / 9 skipped，build 含 typecheck 通过。

## 4. 生产验证发现的清理回归

- [x] 4.1 RED：`npm run test --workspace @inbox/worker -- tests/collectors.test.ts`，09:28:42 为 2 failed / 3 passed，复现同时 3 个删除请求和失败后仍发出后续请求，覆盖已保存链接及 404。
- [x] 4.2 GREEN/REFACTOR：同一聚焦命令 09:28:51 为 5/5 通过；`npm test` 398 passed / 9 skipped，Worker 169 passed，`npm run typecheck`、Worker build、diff check 与 OpenSpec validate 通过，Python 沿用本日已完成检查，无额外重构。
- [x] 4.3 父 digest 与只含清理模块的层预检、Registry 内容 SHA256 读回通过；新修订 inbox-server-worker-dida-cleanup-1010 无流量就绪 200 后切换 100%，Secret/资源/并发/超时不变。

## 5. 真实分发的 ima 拒绝诊断

- [x] 5.1 RED：`npm run test --workspace @inbox/worker -- tests/ima-article-mirror.test.ts`，09:49:52 为 1 failed / 15 passed，缺少数值拒绝码；覆盖日志不记录提供商正文。
- [x] 5.2 GREEN/REFACTOR：仅补充可选 providerCode，同一聚焦命令 09:50:13 为 16/16 通过；Worker 全量 170/170、typecheck/build 通过，错误与状态机兼容，无额外重构。
- [x] 5.3 同父镜像只更新 ima 模块，内容/配置读回通过；inbox-server-worker-dida-ima-diag-1010 承接 100%，09:53:24 真实 article.ima_mirror.succeeded。旧失败不补造提供商拒绝码。

## 6. 本轮三条 ima 异常对账

- [x] 6.1 三条真实 Git 副本、目标知识库与月份目录、文件预检、重名及标记检查通过；按 60/小时既有限速仅补 ima 镜像，独立下载正文和标记摘要全部一致。effect done 与 3 条恢复事件读回成功，原 uncertain 终态审计保留，没有重放队列。
