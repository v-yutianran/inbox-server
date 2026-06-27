## ADDED Requirements

### Requirement: browser collect 在 worker 定时运行
系统 SHALL 在 worker 进程（有 Xvfb + chromium）独立定时（每 60min）运行 browser 源 collect，复用 worker 的 chromium；MUST NOT 在 server（无 DISPLAY）运行 browser collect。

#### Scenario: worker 定时跑 browser collect
- **WHEN** worker 启动且 channels 启用了 browser 源
- **THEN** worker 每 60min 跑一次 browser collect（知乎/B站/inoreader/油管），用 worker 的 chromium，结果入队 Redis

#### Scenario: server 不再跑 browser collect
- **WHEN** server 的 collect_job 触发
- **THEN** 只跑 API 源（telegram/dida），不调用任何 browser/chromium 逻辑，不因无 DISPLAY 崩溃

### Requirement: browser collect 逻辑共享且单源
系统 SHALL 把 browser collect 逻辑（`_collect_browser_sources` + `_create_browser_deps`）抽到共享模块 `browser_collector.py`，worker 调用；MUST NOT 在 server 与 worker 各维护一份。

#### Scenario: 逻辑单源
- **WHEN** 审查代码
- **THEN** browser collect 逻辑只在 `browser_collector.py` 一处，worker import 调用，server 不 import

### Requirement: browser collect 失败不阻塞 worker 消费
系统 SHALL 保证 browser collect 异常不影响 worker 的队列消费（cubox/flomo/坚果云）主流程。

#### Scenario: collect 异常隔离
- **WHEN** browser collect 抛异常（如凭据失效、抓取失败）
- **THEN** 仅记录日志，worker 消费循环继续正常运行

### Requirement: 4 个 browser 源可启用
系统 SHALL 支持在 channels.yaml 启用 zhihu/inoreader/bilibili/youtube（`enabled: true` + `collection_id` + `credential_name`），配合代登录凭据后能 collect。

#### Scenario: 启用并配置凭据后 collect
- **WHEN** channels.yaml 启用某 browser 源并配好 credential_name + 代登录凭据
- **THEN** worker browser collect 能抓取该源新内容并入队
