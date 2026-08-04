## Why

Inoreader 使用虚拟列表时，连续滚动后的可见条目数量可能始终为 30，但条目 ID 已经变化。现有通用滚动逻辑只比较数量，导致一次采集提前停止，并在后续定时任务中重复产生多封“收集 30 条”通知；同时通知中的“发布”容易被误解为最终保存到目标端成功。

## What Changes

- Inoreader 采集按稳定 article key 跨滚动轮次累积并去重，以“本轮没有新 key”或达到轮次上限作为停止条件。
- 保持 YouTube、X 等通用滚动调用的既有停止行为不变。
- 同步通知把 dispatch job 创建数量表述为“已入队”，不再暗示外部目标已经完成保存。
- 增加虚拟列表同数量换页、重叠去重、稳定停止、轮次上限和通知语义的回归测试。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `browser-collect-parity`: Inoreader 虚拟列表必须按稳定 article key 完整累积本次滚动可发现的唯一条目。
- `notification-report`: 同步报告必须明确区分“已入队”与外部目标最终交付成功。

## Impact

- 代码：`apps/worker/src/browser-collectors.ts`、`apps/worker/src/notifications.ts`。
- 测试：Worker 浏览器导航、通知及采集任务回归测试。
- 接口与数据：不修改 D1 schema、Queue envelope、管理 API、Console 或已有配置格式。
- 运行：仅改变 Inoreader 的单次采集完整性和通知文案；不在本变更中执行生产部署或真实用户数据验证。
