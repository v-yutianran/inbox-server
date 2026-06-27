## Why

browser 源（知乎/B站/inoreader/油管）在 fix-parity-gaps 中被标记为「架构断裂/拆后续」：`collect_job` 在 server 容器，但 `playwright_runtime.py` 硬编码 `headless=False`（反爬需 headed chromium）需 worker 的 Xvfb，server 无 `DISPLAY` → `chromium.launch()` 崩，4 源完全不通。这是 inbox-server 对老 dispatcher 最大的功能缺口。本 change 重构 collect 架构（browser collect 挪到 worker，复用其闲置的 chromium+Xvfb）+ 启用配置，让 browser 源真正可用。

## What Changes

- **browser collect 挪 worker**：把 `_collect_browser_sources` + `_create_browser_deps` 从 server 的 `collect_job` 抽出，在 worker 独立定时跑（worker 已装 chromium+Xvfb 但当前闲置）。
- **server collect_job 瘦身**：`run_collect` 只跑 API 源（telegram/dida），不再依赖 chromium。
- **channels.yaml 启用 4 源**：取消注释 zhihu/inoreader/bilibili/youtube + 配 `collection_id` / `credential_name`。
- **代登录凭据**：`POST /login/{platform}/cookie` 配 z_c0（知乎）/ sessdata（B站）等（用户配合）。
- **端到端验证**：知乎收藏 → cubox 等 4 源实地跑通。

## Capabilities

### New Capabilities
<!-- 无全新 capability -->

### Modified Capabilities
- `browser-collect-parity`: 从 fix-parity-gaps 的「规划标注 + checklist」升级为「实现 browser collect 在 worker 定时跑 + 启用 4 源」。新增实现性 requirement。

## Impact

- **代码**：`infrastructure/collectors/`（抽 `browser_collector.py` 共享）、`workers/runner.py`（加 browser collect 定时）、`infrastructure/scheduler.py`（collect_job 去 browser）
- **配置**：`channels.yaml`（启用 4 源）
- **凭据**：代登录（z_c0/sessdata，走 `POST /login`）
- **非范围**：API 源（telegram/dida）仍在 server；消费分发（worker httpx）不变；headed/headless 不变（反爬需 headed）
