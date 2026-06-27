## Context

inbox-server 复刻老 dispatcher（`~/.claude/skills/inbox_dispatcher/`）未闭合：当前仅「telegram/dida → cubox/flomo/坚果云」最小链路跑通。5 类已确认差距：

1. **text→flomo 漏智能标签** — `workers/runner.py:96` text 直接 dispatch，没接 `generate_smart_tags`（老 dispatcher `process_text` 总是生成）
2. **Telegram 同步报告通道未复刻** — `notifications/` 无 telegram notifier
3. **QQ 邮箱报告失效** — `email_enabled=false` + 容器实测无 node/agently-cli（agently-cli 方案在容器跑不起来）
4. **dida 标题残留 md** — `plugins/sources/dida.py` 直接用 `task.title`，未拆 `[标题](url)`
5. **4 个 browser 源禁用 + 架构矛盾** — `channels.yaml` 注释禁用；且 `collect_job` 在 server，但 `playwright_runtime.py` 硬编码 `headless=False` 需 X display，只有 worker 有 Xvfb

约束：Python/FastAPI/docker；测试 pytest；中文注释 + 关键路径日志；每步配 CHANGELOG；修改-验证闭环。

## Goals / Non-Goals

**Goals:**
- text→flomo 消费时生成智能标签，对齐老 dispatcher
- Telegram + Email 双通道同步报告（有新内容才发）
- dida 书签标题干净（剥离 md 链接）
- browser 架构方案明确 + 对等 checklist 产出
- 每处改动配 pytest + CHANGELOG；顺手补 GLM 静默失败的 `log.warning`

**Non-Goals:**
- browser 源实际启用 + collect 重构（拆独立 change）
- 弃用 agently-cli 邮件方案
- 改老 dispatcher 源码

## Decisions

1. **邮件用 smtplib（非 agently-cli）**：容器实测无 node/agently-cli；smtplib 是 stdlib，容器零新依赖。需 QQ SMTP 授权码（`settings.smtp_*`）。*Alternative: agently-cli → 否（容器化失效，PATH 硬编码 `/opt/homebrew/bin` 是坏味道）。*
2. **Telegram 通知复用现有 bot token**：零新凭据，只需配置目标 `chat_id`（`channels.yaml` notification 段）。用 `bot{token}/sendMessage`。
3. **text 标签消费时生成（`_make_process_text`）**：对称于 `_make_process_link`，不在 collect 入队时生成（避免 GLM 洪峰），对齐老 dispatcher「worker 消费时生成」。
4. **dida 标题解析抽到 `urls.py` 纯函数 `extract_url_and_title`**：复刻老 dispatcher 4 分支（md 链接→干净 title / 裸 url→空 title / content 含 url→用 title / 无→不入队），可单测、可复用。*Alternative: 内联 dida.py → 否（不可测试/复用）。*
5. **browser 架构方案（本次仅规划）**：根因是「collect 在 server + server 无 DISPLAY + `headless=False` 硬编码」。方向：把 browser collect 从 `collect_job` 抽到 worker（有 Xvfb）。本次 design 记录方案 + checklist 标注，不实现。
6. **通知触发沿用 `total>0`**：对齐老 dispatcher `total_action==0 提前 return`，无新内容不发。
7. **GLM 静默失败补可见性**：`generate_smart_tags` 的 `except: return []` 加 `log.warning`（本次顺手修隐患，避免下次"无标签且无日志"）。
8. **SMTP 不阻塞 event loop**：用 `aiosmtplib`（或 `asyncio.to_thread(smtplib)`）异步发送。

## Risks / Trade-offs

- **[QQ SMTP 授权码缺失]** → settings 占位；缺失时 EmailNotifier 跳过 + LogNotifier 兜底，不崩（对齐"通知是附加通道"）。
- **[Telegram chat_id 未配]** → 缺失跳过 telegram 通道，不崩。
- **[text 标签 GLM 失败]** → 沿用 `[]` 兜底（flomo 不加前缀），但加 `log.warning` 让失败可见。
- **[browser 架构拆后续]** → checklist 明确标注优先级，避免遗忘；本次不引入半启用状态。
- **[aiosmtplib 新依赖]** → stdlib `smtplib` + `asyncio.to_thread` 可避免新依赖；优先用此方案。

## Migration Plan

1. **配置先行**：`channels.yaml` 加 notification 段（`telegram_chat_id`）、`settings.py` 加 `smtp_*`；QQ 授权码待用户提供（占位可跑，缺失兜底）。
2. **代码分步**（每步 pytest 绿 + CHANGELOG + 独立 commit）：dida 标题 → text 标签 → Telegram 通知 → Email smtplib → checklist 产出。
3. **回滚**：每步独立 commit，可逐 commit revert。
