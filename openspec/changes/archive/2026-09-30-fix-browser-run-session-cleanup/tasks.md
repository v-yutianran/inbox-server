# Tasks

## 1. RED

- [x] 1.1 更新连接和清理回归测试，运行 `npm run test --workspace @inbox/worker -- tests/browser.test.ts`：RED 4 失败、3 通过，原因是 600000 参数、未发送关闭命令及未报告清理失败。

## 2. GREEN / REFACTOR

- [x] 2.1 最小修改连接参数和 finally，同一聚焦命令 GREEN：7 通过。
- [x] 2.2 REFACTOR：无需要的结构调整。`npm run test`：382 通过、9 跳过；`npm run build`（含全工作区 typecheck）通过。`uv run ruff check src/inboxserver tests scripts` 通过；`uv run pytest tests/unit tests/integration -m 'not e2e' --tb=short`：318 通过、1 跳过；`uv run mypy src/inboxserver --ignore-missing-imports`：103 文件通过。

## 3. 真实验证与交付

- [x] 3.1 `node_modules/.bin/tsx e2e/browser-run-lifecycle.ts --dry-run` 预检后执行真实 E2E：成功与失败都终止，会话探测返回 410。ads1 控制台读回 NormalClosure，断线后约 65 秒 BrowserIdle，服务端设置为 60 秒。
- [x] 3.2 单模块镜像只增加 browser.js 替换层，原配置和全部原层保留；部署 revision `inbox-server-worker-browser-close-0930`，零流量 Ready 后切为 100%。`GET /readyz` 与受保护的 `POST /webhooks/worker` 均 200；日志 `worker.webhook.completed`。同一镜像内转译执行相同 E2E，三个场景全部通过。未额外触发采集；下一整点自然业务批次未运行。
- [x] 3.3 已记录当日 Changelog；OpenSpec 正确性和设计一致性核验通过，`openspec validate fix-browser-run-session-cleanup` 通过。归档作为验证后的交付动作。
- [x] 3.4 独立临时 Git index 精确隔离 12 个路径，root Changelog 仅增加本次条目；`git commit --dry-run`、diff check 通过，GitNexus staged 12 文件/16 符号 LOW。浏览器模块及测试包含实现本修复所需的既有未提交接口，其他迁移不纳入。归档后的交付动作是 commit、push dry-run、push 与远端 HEAD 读回。
