## Why

inbox-server 在 `485c46f` 复刻 inbox_dispatcher 时未闭合：目前只跑通「telegram/dida → cubox/flomo/坚果云」最小链路，5 类已确认问题导致功能不与老 dispatcher 对等——text→flomo 无智能标签、Telegram/QQ 邮箱同步报告都不发、dida 书签标题残留原始 markdown 链接格式、4 个 browser 源（知乎/B站/inoreader/油管）因「配置禁用 + 架构矛盾」完全不通。本 change 收敛这些问题，让现有链路先对齐老 dispatcher，并产出完整对等 checklist 把残余差距显性化，避免逐个发现、逐个补。

## What Changes

- **text→flomo 智能标签补全**：`workers/runner.py` 新增 `_make_process_text`，消费 text 时调 `generate_smart_tags` + `fmt_flomo_tags` 拼 `#标签` 前缀，对齐老 dispatcher `process_text`。
- **Telegram 同步报告通道**：新增 `notifications/telegram_notifier.py`（复用 telegram bot token + `sendMessage`），`_notify_results` 增加 Telegram 通道。
- **QQ 邮件报告改 smtplib**：`EmailNotifier` 从 agently-cli（容器内无 node，实测发不出）改为 Python stdlib `smtplib` 直连 QQ SMTP；需 QQ SMTP 授权码。
- **dida 书签标题 md 拆分**：`domain/policy/urls.py` 新增 `extract_url_and_title(title, content)`（复刻老 dispatcher 4 分支），`plugins/sources/dida.py` 改用它，剥离 `[标题](url)` 得干净标题。
- **browser 源架构方案（本次规划，启用拆后续）**：design 明确「把 browser collect 从 server 挪到有 Xvfb 的 worker」方案，并修掉 browser 源代码层缺陷；实际启用 + 架构重构拆为独立 change。
- **对等 checklist**：产出 `inbox_dispatcher → inbox-server 功能对等 checklist` 文档，逐条标注「已对等/缺失/配置缺失/架构断裂/待验证」+ 修复优先级。

## Capabilities

### New Capabilities
<!-- openspec/specs/ 当前为空（本次 init），全部为新增 capability -->
- `notification-report`: 同步报告通知，支持 Telegram + Email 双通道（有新内容才发，对齐老 dispatcher total>0 触发）
- `dispatch-tagging`: 分发时智能标签生成，覆盖 link→cubox（已具备）+ text→flomo（本次补全）
- `source-parsing`: source 内容解析，含 dida/telegram 标题与 URL 提取（md 链接拆出干净标题）
- `browser-collect-parity`: browser 源对等规划（架构方案 + 代码层缺陷修复；启用拆后续 change）

### Modified Capabilities
<!-- 无既有 spec 需修改 -->

## Impact

- **代码**：`workers/runner.py`、`notifications/{telegram_notifier,email_notifier}.py`、`domain/policy/urls.py`、`plugins/sources/dida.py`、`infrastructure/scheduler.py`
- **配置**：`config/settings.py`（smtp 配置、telegram 通知目标 chat_id）、`channels.yaml`（新增 notification 段；llm 段不变）
- **依赖**：新增 stdlib `smtlib`/`email`（无新三方依赖）；**移除**对 agently-cli/node 的运行时依赖
- **文档**：对等 checklist 入库（`docs/`）
- **非本次范围**：browser 源实际启用 + 架构重构（拆为独立 change，checklist 中标注）
