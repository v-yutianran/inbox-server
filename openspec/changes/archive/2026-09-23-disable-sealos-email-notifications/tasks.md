# Tasks

## 1. RED：锁定开关和通知行为

- [x] 1.1 在 Worker 通知测试中覆盖邮件开关关闭且 SMTP 凭据齐全时仅尝试 Telegram，以及 Telegram 发送失败时不回退 SMTP；运行 `npm run test --workspace @inbox/worker -- tests/notifications.test.ts`，确认新增断言因目标行为失败，并记录 RED 命令与原因到本任务和当日 Changelog。**证据**：RED 4 项中 2 项精确失败（关闭时仍调用 SMTP；Telegram 失败时仍尝试 SMTP）；GREEN/REFACTOR 同命令 4/4。
- [x] 1.2 在 Worker 配置测试中覆盖默认启用、显式关闭及非法值拒绝启动；运行 `npm run test --workspace @inbox/worker -- tests/config.test.ts`，确认新增断言因目标行为失败，并将 RED 命令与原因记录到本任务和当日 Changelog。**证据**：RED 6 项中 3 项目标断言失败（默认值/false 解析不符，`yes` 未拒绝）；GREEN/REFACTOR 同命令 6/6。
- [x] 1.3 在部署文件测试中断言 Sealos Worker 清单显式关闭邮件；运行 `uv run pytest tests/unit/test_deployment_files.py --tb=short`，确认新增断言因清单尚未配置而失败，并将 RED 命令与原因记录到本任务和当日 Changelog。**证据**：RED 1 failed/11 passed，唯一失败为环境值为 None；GREEN/REFACTOR 同文件 12/12。

## 2. GREEN：实现默认开启、可显式关闭的邮件通道

- [x] 2.1 在现有 Worker 配置中解析 `EMAIL_NOTIFICATIONS_ENABLED`，默认 `true` 且仅接受 `true`/`false`；将结果传给通知器并只门控 SMTP 发送。运行 `npm run test --workspace @inbox/worker -- tests/notifications.test.ts` 与 `npm run test --workspace @inbox/worker -- tests/config.test.ts`，确认新断言和原有双通道行为均通过，并将 GREEN 命令与结果记录到本任务和当日 Changelog。**证据**：notifications 4/4、config 6/6；组合聚焦命令 `npm run test --workspace @inbox/worker -- tests/config.test.ts tests/notifications.test.ts` 10/10。
- [x] 2.2 在 `deploy/sealos/worker-staging.yaml` 显式设置 `EMAIL_NOTIFICATIONS_ENABLED: "false"`。运行 `uv run pytest tests/unit/test_deployment_files.py --tb=short`，确认部署清单契约通过，并将 GREEN 命令与结果记录到本任务和当日 Changelog。**证据**：部署文件测试 12/12。

## 3. REFACTOR：回归、门禁与记录

- [x] 3.1 只整理有明确收益的改动；重跑 Worker 通知、配置与部署清单聚焦测试，并将 REFACTOR 命令和结果记录到对应任务及当日 Changelog。**证据**：组合聚焦测试 10/10，部署文件测试 12/12；Worker typecheck/build 通过。
- [x] 3.2 运行 TypeScript 全 workspace 测试、类型检查与构建：`npm test`、`npm run typecheck`、`npm run build`；记录每项结果。**证据**：`npm test` 首次因 `npm ci` 后 `@inbox/domain/dist` 尚未构建而出现 API/Worker 模块加载失败；运行 `npm run build --workspace @inbox/domain` 后原样重跑通过：API 66、Console 15、Worker 127、Domain 8、release-operations 30，共 246；`npm run typecheck` 与 `npm run build` 通过。
- [x] 3.3 运行项目 Python 门禁：`uv run ruff check src/inboxserver tests scripts`、`uv run pytest tests/unit tests/integration -m "not e2e" --tb=short`、`uv run mypy src/inboxserver --ignore-missing-imports`；记录通过、失败或基线告警。**证据**：ruff 通过；本轮 pytest 266 passed/8 warnings；mypy 通过，含 2 条 annotation-unchecked notes。
- [x] 3.4 运行 `openspec validate disable-sealos-email-notifications`，通过 git-manager 核对 Git 状态与改动范围，并运行 GitNexus `detect_changes`；索引不完整时结合源码核对并如实记录限制。**证据**：OpenSpec validate 通过；第一笔提交前的 git-manager config/inspect/status 显示当时 `main` 与 `origin/main` 同步，工作树存在本任务未提交改动；GitNexus scope all、repo `inbox-server`、current checkout 检测为 medium、2 flows，索引为 lower-bound，源码核对确认直接入口。
- [x] 3.5 使用 docs-manager 更新 `docs/production-operations-runbook.md`，说明环境开关的默认值、Sealos 显式关闭设置及旧镜像回滚可能恢复邮件的风险；核对文档入口与引用有效。**证据**：runbook 已记录默认开启、Sealos 显式关闭及回滚风险；docs audit exit 0，报告 5 条既有 warning。
- [x] 3.6 更新根 `CHANGELOG.md` 与 `docs/changelog/2026-09-23.md`，记录 RED/GREEN/REFACTOR 实际命令及结果、未运行门禁和残余风险；若当日日志不存在则创建并在根索引增加唯一日期链接。

## 4. 独立授权后的 Sealos 验收

- [x] 4.1 预检并发布不可变 Worker 镜像，部署后核对 active revision、邮件开关与健康状态。**证据**：本地 commit/push `930072cefa6c05f6466c78f2e8211a85b65a7bf1`；`docker buildx build --check --platform linux/amd64 -f Dockerfile.worker .` 无警告，本地 linux/amd64 `--load` 构建与镜像 push 成功，`docker buildx imagetools inspect` 确认 GHCR/NJU manifest digest 相同（`sha256:007b1143...9512`）。StatefulSet server-side patch dry-run 两次通过；NJU blob 拉取返回 500，首次 `kubectl rollout status statefulset/inbox-server-worker-staging --timeout=20m` 超时，随后 StatefulSet 和未就绪 Pod 切换到同 digest 的 GHCR 源站，Pod 由 StatefulSet 自动重建，未执行实际 delete。第二次 rollout 成功。`kubectl get statefulset,pod -o json` 核对 generation 57、current/update revision 均为 `inbox-server-worker-staging-5f9d967b5`、readyReplicas 1；Pod 三容器 Ready、restart 0。Pod 内运行时核对 `EMAIL_NOTIFICATIONS_ENABLED=false`、deploymentVersion `930072`，`/healthz` 与 `/readyz` 均为 200，browser/mihomo/warp 均 ready。
- [x] 4.2 在新 revision 就绪后，等待自然产生的通知并由人工确认 Telegram 送达且未发送邮件；不使用真实业务对象生成测试通知，并记录实际观察证据。**证据**：用户于本轮人工确认 Telegram 已送达且未收到对应邮件；未发送合成通知。近 10 分钟日志未见 `telegram_notification_failed` 或 `email_notification_failed`。观察到一条 inoreader collect-source permanent dead_lettered，其与本功能的关系尚未证实。
