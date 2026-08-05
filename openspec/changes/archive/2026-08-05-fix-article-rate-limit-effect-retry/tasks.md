## 1. RED：锁定状态机与迁移契约

- [x] 1.1 为延期秒数、最晚 `retryAt`、失败预算与状态转换补充失败的纯函数测试
- [x] 1.2 为 D1 新旧 schema、历史 DLQ 原字段保持和恢复信封生命周期补充失败的迁移测试
- [x] 1.3 为批量限速原子性、早到重投、effect `busy` 与三次真实失败预算补充失败的控制面测试
- [x] 1.4 为文章 handler 的“先限速后 claim effect”、类型化延期和外部调用次数补充失败的 Worker 测试
- [x] 1.5 为认证重放、`dryRun`、运维幂等、`done`/`uncertain` 拒绝及敏感信息禁漏补充失败的 API 测试

## 2. GREEN：实现 D1 状态与持久化

- [x] 2.1 新增非破坏性 D1 迁移，扩展 job 延期/失败预算字段并创建加密恢复信封与运维幂等表
- [x] 2.2 实现可单测的延期、失败预算、分段延时和批量限速决策纯函数
- [x] 2.3 实现文章 job 的显式延期状态、独立 `failure_attempts` 及历史 DLQ 只读关联
- [x] 2.4 复用 AES-GCM 能力持久化新文章任务信封，并实现成功、dead、uncertain 生命周期

## 3. GREEN：实现控制面与 Worker 编排

- [x] 3.1 实现原子批量限速内部契约，拒绝时不部分扣减并返回最晚 `retryAt`
- [x] 3.2 扩展 effect `busy` 与 job finish 契约，返回类型化延期和不超过 300 秒的分段重试
- [x] 3.3 调整文章 Worker 顺序为批量限速后领取 effect，并将限速/busy 记录为无损延期
- [x] 3.4 实现不含业务 payload 的延期、真实失败、DLQ 与恢复结构化事件

## 4. GREEN：实现受控恢复与安全边界

- [x] 4.1 实现受内部认证保护的 dead-letter 重放 `dryRun` 与实际发布契约
- [x] 4.2 保证重放沿用原 job/dedupe/schema，使用运维幂等键且拒绝历史、`done`、`uncertain` 与校验失败任务
- [x] 4.3 验证公开 API、Console 快照和日志均不返回明文或加密恢复信封

## 5. REFACTOR：收敛重复逻辑与回归

- [x] 5.1 复用现有限速、认证、加密和 Queue 发布抽象，清理本次产生的重复与无用代码
- [x] 5.2 运行 AT-01 至 AT-14 的合成数据测试，确认 link/text/file 与既有限额配置无回归
- [x] 5.3 运行隔离 D1 迁移/回滚演练并比较历史 DLQ 不可逆摘要，不连接生产 D1 写入

## 6. 文档、门禁与交付

- [x] 6.1 更新 `CHANGELOG.md`，记录行为、迁移、安全边界和验证命令
- [x] 6.2 运行 `npm test`、`npm run typecheck`、`npm run build` 及 Python 自验四件套中适用的非 E2E 门禁
- [x] 6.3 运行 OpenSpec strict validate、`git diff --check` 与 GitNexus `detect_changes`，确认变更范围
- [x] 6.4 使用 `git-manager` 精确提交、普通 push 并创建或复用 PR；禁止自动 merge
