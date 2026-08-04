## Context

`scrollExtract` 当前以“可见条目数量与上一轮相同”为停止条件，并用当前轮结果覆盖累计结果。该策略适合 DOM 随滚动增长或最终稳定的页面，但 Inoreader 的虚拟列表会保持固定可见数量并替换条目，导致相同数量的新 article key 被误判为稳定。采集成功后，`collect_job` 创建 dispatch jobs，再把 `published` 数量交给通知格式化器；该字段表示队列入队数，不是 Cubox 或文章归档的最终结果。

约束包括：通用滚动函数同时被 Inoreader、YouTube 和 X 使用；Inoreader baseline 以 article key 持久化；不得修改 Queue、D1、API、Console 或生产部署契约；自动验证不得连接真实用户数据或真实外部目标。

## Goals / Non-Goals

**Goals:**

- 单次 Inoreader 采集累积滚动过程中发现的全部唯一 article key。
- 没有新 key 时及时停止，并保留 20 轮硬上限。
- 保持未启用稳定 key 策略的 YouTube、X 调用行为不变。
- 通知准确说明 dispatch jobs “已入队”。

**Non-Goals:**

- 不新增外部目标最终交付成功的聚合通知。
- 不重置或迁移生产 baseline，不处理既有 DLQ。
- 不修改数据库、Queue envelope、API、Console 或部署清单。
- 不在本变更中自动部署 Cloudflare/Sealos，也不使用真实账号执行 E2E。

## Decisions

### 1. 为通用滚动函数增加可选稳定 key 选择器

`scrollExtract` 保留现有参数和默认数量稳定算法，仅在调用方显式传入 `stableKey` 时使用 `Map` 按首次发现顺序累积唯一条目；某轮新增 key 数为 0 时停止。Inoreader 传入 article `key`，YouTube 与 X 不传，因此默认行为不变。

选择该方案是因为它复用现有滚动、等待和轮次上限，同时把虚拟列表语义限制在显式调用点。备选方案是复制一个 Inoreader 专用滚动循环，但会形成两份浏览器编排逻辑；另一备选方案是让所有来源统一按 key 累积，但会扩大 CRITICAL 公共路径的行为变更。

### 2. baseline 只合并本次新发现的 key

采集完成后继续沿用现有 `known + fresh.key` 的单调合并，不删除既有 key。稳定 key 累积只改变本次 `items` 的完整性，不改变持久化格式和状态写入顺序。

### 3. 只修改用户可见术语，不改内部字段

保留 `CollectionNotification.published` 和 job summary 数据契约，格式化时输出“已入队”。这样无需修改调用链或持久化数据，同时消除最终交付成功的错误暗示。

### 4. 复用既有成功事件作为可观测证据

`worker.job.succeeded` 已记录低敏感度的 job kind、耗时和 summary；collect summary 包含 source、collected、published。该事件足以观察修复后的单次采集结果，因此不新增重复日志，也不记录文章标题、URL 或凭据。

## Risks / Trade-offs

- [Inoreader 页面持续产生新 key，单次采集时间变长] → 保留 20 轮硬上限，并测试达到上限后可确定返回。
- [稳定 key 选择器错误导致条目被错误合并] → 只使用解析后必填的 Inoreader article key，并测试重叠窗口和同数量换页。
- [公共函数签名变更影响其它来源] → 参数为可选且默认分支保持原逻辑，增加 YouTube/X 默认行为回归测试与 Worker 完整测试。
- [“已入队”仍不等于最终保存成功] → 文案明确限定在队列阶段，最终交付聚合保持在本次范围外。

## Migration Plan

1. 在合成 Page stub 上通过定向单元测试和 Worker 全量测试。
2. 通过 typecheck、build、OpenSpec 与验收文档校验后提交 PR。
3. 合并后的生产部署由单独授权执行；无需数据迁移。
4. 若出现回归，回滚该代码提交即可恢复旧滚动与通知行为，baseline 数据格式不受影响。

## Open Questions

- 无。本次不决定最终交付聚合通知的产品口径。
