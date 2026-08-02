## Why

TypeScript Worker 在文章任务被内部限速拒绝后，当前重试可能仍受上一轮 effect `processing` 租约阻塞，并把“等待限速窗口”累计为失败尝试，最终错误进入 DLQ。生产重放已暴露这一竞态；同时现有 DLQ 仅保留 payload digest，无法保证历史任务可恢复，因此需要在继续处理新增文章任务前明确安全的延期、幂等与可恢复边界。

## What Changes

- 将文章任务的内部限速拒绝定义为“延期”而非“处理失败”，不得因此消耗失败重试预算或进入 DLQ。
- 保证未开始外部分发的限速延期不会留下阻塞后续重试的活跃 effect 租约，并按控制面给出的 `retryAt` 安全重试。
- 保证同一文章任务在重试、Worker 重启和 Queue 重投场景下仍保持至多一次外部归档副作用。
- 为变更上线后的文章任务保留可受控重放所需的持久化任务材料；历史 DLQ 保持只读，不承诺从现有 digest 反推或自动恢复原始 payload。
- 补充结构化可观测事件与可使用合成数据执行的验收门禁，禁止验证流程删除历史 DLQ 或重放真实用户数据。

## Capabilities

### New Capabilities

- `article-queue-retry-safety`: 规定文章队列在限速、effect 租约、重试、DLQ 与可恢复性方面的行为不变量。

### Modified Capabilities

无。

## Impact

- 受影响系统：Cloudflare Queue 拉取与结算、Cloudflare D1 控制面、Sealos TypeScript Worker、文章归档 effect 状态和 DLQ 查询。
- 受影响契约：文章任务的限速结果、延期时间、失败尝试计数、effect 可领取状态，以及新任务的受控重放材料。
- 不改变 Console 与公开 API 的认证边界，不改变文章提取策略、Git 归档格式、既有限速额度，也不删除或改写现有历史 DLQ。
