# browser-collect-parity Specification

## Purpose
TBD - created by archiving change fix-parity-gaps. Update Purpose after archive.
## Requirements
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

### Requirement: Inoreader 虚拟列表完整采集
系统 SHALL 在单次 Inoreader browser collect 中先等待至少一个可提取 article 就绪，再按稳定 article key 累积滚动过程中发现的唯一条目；系统 MUST NOT 仅因连续两轮可见条目数量相同而停止，也 MUST NOT 把页面未就绪误报为零新增；当一轮没有发现新 key 或达到固定轮次上限时 SHALL 停止。

#### Scenario: body 先于 article 就绪
- **WHEN** Inoreader 的 `document.body` 已出现，但带稳定 key 的 article 延迟渲染
- **THEN** 系统在 60 秒预算内等待至少一个可提取 article，并在就绪后进入滚动采集

#### Scenario: article 在预算内始终未就绪
- **WHEN** Inoreader 未跳转登录页且在内容就绪预算内始终没有可提取 article
- **THEN** 系统显式报告内容未就绪失败，且不更新 baseline、不创建 dispatch job、不发送同步通知

#### Scenario: 等待期间登录失效
- **WHEN** Inoreader 在内容就绪等待期间跳转到登录页
- **THEN** 系统报告登录失效，且不更新 baseline、不创建 dispatch job、不发送同步通知

#### Scenario: 相同数量但 key 已变化
- **WHEN** Inoreader 连续两轮各显示 30 条且第二轮包含新的 article key
- **THEN** 系统继续累积第二轮的新 key，并把两轮唯一条目纳入本次采集结果

#### Scenario: 重叠窗口去重
- **WHEN** 相邻滚动轮次包含重复 article key 和部分新 key
- **THEN** 系统按 article key 去重并保留首次发现顺序

#### Scenario: 没有新 key 时停止
- **WHEN** 当前轮所有 article key 均已在本次采集中出现
- **THEN** 系统停止继续滚动并返回已累计的唯一条目

#### Scenario: 达到轮次上限
- **WHEN** 每轮持续出现新 article key 直到固定轮次上限
- **THEN** 系统在上限处停止并返回上限内累计的唯一条目

#### Scenario: 其它来源保持既有停止行为
- **WHEN** YouTube 或 X 未显式提供稳定 key 策略
- **THEN** 系统继续按既有可见数量稳定规则停止并返回既有结果形态
