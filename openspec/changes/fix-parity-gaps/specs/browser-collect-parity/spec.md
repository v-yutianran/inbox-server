## ADDED Requirements

### Requirement: 记录 browser collect 架构方案
本 change 的 design.md SHALL 记录 browser 源（知乎/B站/inoreader/油管）的架构矛盾根因（collect_job 在 server，但 headed chromium 需 worker 的 Xvfb）与解决方向（把 collect 抽到有 Xvfb 的 worker），作为后续启用 change 的依据。

#### Scenario: 方案可追溯
- **WHEN** 审查本 change 的 design.md
- **THEN** 能定位 browser 架构根因、「collect 挪 worker」方案、以及「启用拆为独立 change」的说明

### Requirement: 产出对等 checklist 并标注 browser 差距
系统 SHALL 产出 inbox_dispatcher → inbox-server 功能对等 checklist 文档，逐条标注状态（已对等 / 缺失 / 配置缺失 / 架构断裂 / 待验证）与修复优先级，其中 4 个 browser 源 SHALL 标注为「架构断裂 / 拆后续」。

#### Scenario: checklist 覆盖 browser 源
- **WHEN** 查阅对等 checklist 文档
- **THEN** 知乎 / B站 / inoreader / 油管 4 源均标注为架构断裂或拆后续，且明确不在本 change 启用范围
