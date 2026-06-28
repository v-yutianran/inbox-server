# 实现任务清单

> 方案A：browser collect 在 worker 独立定时（复用 worker chromium+Xvfb），server collect_job 瘦身。
> 每组配 pytest + CHANGELOG + 独立 commit。

## 1. 抽 browser collector 共享模块

- [x] 1.1 新建 `infrastructure/collectors/browser_collector.py`：把 orchestrator 的 `_collect_browser_sources` + `_create_browser_deps` 抽出为 `async def collect_browser_sources(channels, http, queue_repo, session) -> dict`
- [x] 1.2 `orchestrator.run_collect` 删 browser 调用，只留 telegram/dida（server 不再 import browser 依赖）
- [x] 1.3 新增/迁移单测：browser_collector 逻辑等价（mock chromium pool）

## 2. worker 加 browser collect 定时

- [x] 2.1 `workers/runner.py` `run_worker` 加 APScheduler（AsyncIOScheduler），每 60min 跑 `collect_browser_sources`，与消费 `gather` 并发（asyncio task）
- [x] 2.2 browser collect 异常 try/except + log，不阻塞消费循环
- [x] 2.3 worker browser collect 单测（mock chromium，验证定时触发 + 异常隔离）

## 3. server collect_job 瘦身验证

- [x] 3.1 确认 server 容器不再 import/触发 browser collect（grep chromium/playwright in server 启动路径）
- [x] 3.2 server collect_job 只跑 API 源的回归测试

## 4. 启用 4 源配置

- [x] 4.1 `channels.yaml` 取消注释 zhihu/inoreader/bilibili/youtube + 配 `enabled: true` + `collection_id` + `credential_name`
- [x] 4.2 代登录凭据：`POST /login/{platform}/cookie` 配 z_c0（知乎）/ sessdata（B站）（用户配合）

## 5. 端到端验证

- [x] 5.1 worker browser collect 实地：知乎收藏 → cubox（标题/标签）
- [x] 5.2 全量 `pytest` 绿
- [x] 5.3 `openspec validate browser-collect-worker` + CHANGELOG
