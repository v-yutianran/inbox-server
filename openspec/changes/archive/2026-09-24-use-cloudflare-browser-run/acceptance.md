# Cloudflare Browser Run 验收

版本 1；更新于 2026-09-24；对象为当前 worker 工作树及 Cloud Run 修订版 `00003-gut`。本文件保留 2026-09-23 本地验收记录，并追加真实云端验收样本。需求：[proposal.md](proposal.md)；设计：[design.md](design.md)。当前浏览器来源及观察到的请求/租约窗口验收通过；极端超时压力未验证。

## 验收范围与准入条件与退出条件

本地范围是远程配置、连接生命周期、旧模式回归和镜像内容；使用假的 CDP 连接及合成队列，不读取真实账号。进入云端验收前必须完成数据持久化、独立 Secret 注入、可恢复批次结算和镜像构建；退出要求逐源真实证据、限额核对及 Cloud Run 请求内结算。缺任一项不得发布。

## 需求追踪矩阵与验收用例

| 用例 | 需求/标准 | 前置条件与步骤 | 预期 | 证据/实际结果 |
|---|---|---|---|---|
| TC-001 | REQ-001 / AC-001 | 本地合成环境分别缺少账号 ID、令牌，测试代理冲突及默认连接超时 | 配置拒绝且日志无凭据；远程默认超时 30 秒 | config.test.ts 通过，缺失配置/冲突被拒绝；真实启动日志未观察 |
| TC-002 | REQ-001/002 / AC-002 | 假 CDP 连接，依次给空批次、纯非浏览器批次和浏览器批次 | 前两者零连接；浏览器批次处理与结算后关闭连接 | browser.test.ts、job-handler.test.ts、worker-webhook.test.ts 合成测试通过 |
| TC-003 | REQ-001/002 / AC-002 | 假连接失败、处理失败及停止信号 | 不确认未完成 lease，返回可重试失败并释放资源 | 假连接/处理失败测试通过；真实断连与停止信号未执行，部分覆盖 |
| TC-004 | REQ-003 / AC-003 | 默认配置启动旧模式；检查 Cloud Run 镜像构建步骤 | 旧 headed 行为不变；新镜像无本地 Chromium/Xvfb | 旧模式测试与 linux/amd64 镜像构建通过；旧 Dockerfile 未改，真实容器运行未执行 |
| TC-005 | REQ-003 / AC-004 | 使用已授权来源账号逐一执行 shadow 收集，记录来源键、基线、去重与登录结果 | 知乎、B站、Inoreader、YouTube 各有可复核的相同来源验收证据 | 真实来源增量结果见“2026-09-24 云端验收”；各来源 shadow 已完成，Inoreader 重新授权后复验通过 |

## 初始本地验收记录（2026-09-23）

本地合成检查覆盖 TC-001、TC-002、TC-004，TC-003 仅部分覆盖；当时 TC-005 未执行。四个聚焦文件 34/34 通过；`npm test` 270/270 通过，`npm run typecheck`、`npm run build` 和 linux/amd64 镜像构建通过。Cloudflare API 连接器对 `https://example.com/` 的 Browser Rendering content 冒烟调用返回 HTTP 200 且包含 Example Domain；这只证明该账号的服务连通性，不覆盖 CDP、长期令牌或真实来源。该段记录的是 2026-09-23 状态。

## 初始本地验收的未执行项（2026-09-23）

当时 Cloudflare Browser Run 来源兼容性、长期令牌、Cloud Run 请求与租约窗口及整体数据迁移均未验收；以下增量记录更新了本 change 中的来源与运行窗口证据。Cloud Run `/data` 持久化、整体迁移及回退属于独立验收范围。

## 2026-09-24 云端验收

- 按已授权账号完成七个来源的逐源 Browser Run shadow。Inoreader 登录态更新后再次 shadow，`collected=7`、`published=0`；随后真实 scheduler 收集并发布 Inoreader 7 项、知乎 17 项，相关分发 effects 均为 `done`。B 站收藏、稍后再看与 YouTube 的来源 shadow 通过；完整运行证据见当日 `docs/changelog/2026-09-24.md`。首次 Inoreader 登录过期的旧观察已由重新授权后的复验更新。
- Cloudflare 控制台核对为 Paid plan，Browser Run 累计 usage `0.72/10` 小时、平均并发 `1/10`。Cloud Run 修订版 `00003-gut` 配置 `maxInstances=1`、`concurrency=1`、请求超时 `900s`；Queue visibility timeout 为 `300s`。
- 03:00 UTC 后观察到的 12 次成功 webhook 请求最长 `157.896s`。一次 webhook 请求内包含 Queue pull、批次处理和 settlement，因此该请求耗时是这些样本中 lease 持有时长的上界；`157.896s < 300s < 900s`。03:00 与 04:00 UTC 两轮 scheduler 和任务均为 `done`，Neon inbox 为 0。期间出现的瞬时 429 与冷启动 503 均在 Queue 重试后结清。
- 以上是已观察流量的样本，不代表 720 秒 drain budget、900 秒 Cloud Run timeout 或极端慢批次已做压力验证；当前单批不可中断的边界仍需作为运行风险保留。此前存在的知乎 `uncertain` 任务不属于这些新成功样本，未重放、未改写，仍需单独核对目标端。

结论：TC-005 与 3.3 的真实来源、Browser Run 配额及观察请求/租约窗口验收通过。样本外极端超时、整体数据迁移及回退演练不由本项覆盖。
