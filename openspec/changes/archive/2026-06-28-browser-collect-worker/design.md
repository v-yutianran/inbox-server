## Context

worker 容器**已装 chromium + Xvfb**（docker-compose worker command `Xvfb :99 & export DISPLAY=:99`），但当前 worker 只用 httpx 消费队列分发到 cubox/flomo/坚果云，**chromium 完全闲置**——说明设计本意就是"browser collect 该在 worker"，只是 `collect_job` 错放在 server（server 无 DISPLAY）。fix-parity-gaps 的 design 决策 5 记录了矛盾，本 change 落地方案。

现状链路：`scheduler.collect_job`(server) → `orchestrator.run_collect` → `_collect_browser_sources` → 各 browser source.collect（需 chromium）→ 崩。

## Goals / Non-Goals

**Goals:**
- browser collect 在 worker（有 Xvfb）跑通，4 源可用
- server collect_job 只跑 API 源，不再依赖 chromium
- channels.yaml 启用 + 凭据配置
- 端到端实测（知乎收藏→cubox 等）

**Non-Goals:**
- 改 API 源（telegram/dida 仍在 server collect_job）
- 改消费分发（worker 的 cubox/flomo/坚果云 消费不变）
- 改 headed/headless（知乎反爬需 headed，保持 `headless=False`）

## Decisions

1. **方案A：browser collect 在 worker 独立定时**。worker 加 APScheduler（AsyncIOScheduler）每 60min 跑 browser collect，与消费 `gather` 并发（asyncio task）。server collect_job 只 API 源。*Alternatives：B server 触发 worker（需队列协议，复杂）/ C 全部挪 worker（telegram/dida 也动，改动大）。A 复用 worker 闲置 chromium、职责最清晰、改动最小。*
2. **抽共享模块 `infrastructure/collectors/browser_collector.py`**：把 orchestrator 的 `_collect_browser_sources` + `_create_browser_deps` 抽出为 `collect_browser_sources(channels, http, queue_repo, session)`，server 不调、worker 调。逻辑只一份（DRY）。*Alternative：两边各写一遍 → 否（重复）。*
3. **worker 双职责**：消费（httpx，现有）+ browser collect（chromium，新增）。两者不冲突（消费无 chromium、collect 用 chromium），共享一个 event loop（gather + scheduler task）。chromium pool 在 collect 时按需创建。
4. **server collect_job 瘦身**：`run_collect` 删 `_collect_browser_sources` 调用，只留 telegram/dida。orchestrator 的 browser 逻辑移走后 server 不再 import browser 依赖。
5. **启用 + 凭据**：channels.yaml 取消注释 + 配 `collection_id`/`credential_name`；代登录凭据走现有 `POST /login/{platform}/cookie`（CredentialVault，master_key 已配）。

## Risks / Trade-offs

- **[worker 双职责复杂度]** → 消费与 collect 并发，共享 loop；collect 用 chromium 不影响消费（httpx）。监控 worker 健康healthcheck 已覆盖。
- **[两 scheduler 不同步]** → server API collect 与 worker browser collect 各自整点 60min，时间略错开可接受（都每小时）。
- **[代登录凭据失效]** → zhihu source 已有 `401 → mark_expired + 重试` 逻辑；sessdata 同理。
- **[worker browser collect 失败不阻塞消费]** → collect 异常 try/except，记 log，不影响消费循环。

## Migration Plan

1. 抽 `browser_collector.py` 共享 + 单测（逻辑等价迁移）
2. worker `run_worker` 加 APScheduler browser collect 定时
3. server `run_collect` 去 browser（瘦身）+ 测试
4. channels.yaml 启用 4 源
5. 代登录凭据（用户配合 POST /login）
6. 端到端：知乎收藏 → cubox 实测
