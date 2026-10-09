## Why

Cloud Run Service 的 worker 需要在请求期间使用浏览器；当前镜像先启动 Xvfb 与本地 headed Chromium，且浏览器实例在无请求期间常驻。用户已指定 Cloudflare Browser Run，因此需要显式的远程浏览器生命周期与来源兼容性验收。

## 背景与问题

现有 browser.ts 使用 `headless: false`，而 Browser Run 提供 Cloudflare 侧 headless 浏览器；当前 worker 的单例浏览器会因远程会话空闲过期而失效。旧运行方式见 `docker-worker-runtime` 主规格。

## What Changes

- 增加远程浏览器模式和按批次连接生命周期。
- 提供无需本地浏览器与 Xvfb 的 Cloud Run 镜像，并保留旧部署。
- 远程浏览器从 headed 变为 Cloudflare 侧 headless，属于来源兼容性的 **BREAKING** 风险；未通过真实来源验收不得切生产。

## 需求清单

- REQ-001：增加独立的 Browser Run 模式，使用受保护的 Cloudflare 账号凭据建立 Playwright CDP 连接；缺少配置或连接失败时拒绝处理浏览器任务。
- REQ-002：webhook 按需处理期间持有远程浏览器连接，任务结算后关闭；长时间无请求时不占用 Browser Run 会话。
- REQ-003：Cloud Run 镜像无需本地 Chromium 与 Xvfb；现有 Sealos headed 模式保持可用，切换前逐源核对登录、解析、基线与去重。

## Capabilities

### New Capabilities

- `cloudflare-browser-run-runtime`：定义远程连接、生命周期、失败与来源兼容验收。

### Modified Capabilities

无；`docker-worker-runtime` 的 Sealos headed 要求继续适用于旧部署。

## Impact

目标为 `fullstack-fastapi-0923` 项目、`asia-east1` Cloud Run Service 和 `apps` Artifact Registry。涉及 worker 浏览器配置、启动及批次执行、容器构建与测试；不修改 D1/队列数据模型，不读取或写入真实登录态，不在本变更中部署生产。与 `add-cloud-run-worker-webhook` 共用主进程接线，该 change 仍保持 active。

## 范围与成功标准

版本 1；状态：设计中。目标用户为已有 Cloudflare Browser Run 凭据的 worker 运维者；成功指标是每批请求在结算后释放连接且来源验收无去重回归。

## 验收标准

- AC-001：缺少远程账号或令牌启动配置失败，日志无凭据。
- AC-002：一批 webhook 工作只使用按需建立的浏览器连接，结算后释放，失败时也释放。
- AC-003：本地 headed 模式不回归，Cloud Run 镜像不安装本地浏览器。
- AC-004：逐源真实验收记录知乎、B站、Inoreader、YouTube 的登录、解析、基线与去重；未验收时保持发布阻塞。

## 需求覆盖检查

REQ-001→AC-001/002，REQ-002→AC-002，REQ-003→AC-003/004。

## 非目标与依赖

本变更不迁移 PostgreSQL/Redis、文章 Git 工作区或 IMA 标记，也不决定 Cloud Run 调度器；它们仍是整体发布前置条件。Browser Run Free 当前限额与来源反爬可能限制实际可用性，必须以控制台和真实验收复核。浏览器令牌需从 Cloudflare 控制台经 Secret Manager 注入，不从 DBX 或日志提取。
