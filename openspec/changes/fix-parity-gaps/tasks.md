# 实现任务清单

> 按 design 的 Migration Plan 顺序，每组独立可验证、配 pytest + CHANGELOG + 独立 commit。
> 参考老 dispatcher：`~/.claude/skills/inbox_dispatcher/inbox_sync.py`。

## 1. 配置先行（占位可跑，缺失兜底）

- [x] 1.1 `config/settings.py` 加 SMTP 配置（smtp_host/smtp_port/smtp_user/smtp_pass/from_addr，默认空）+ telegram 通知开关字段
- [x] 1.2 `channels.yaml` 加 `notification` 段（`telegram_chat_id` 占位，复用 telegram source 的 bot_token）+ 留 SMTP 说明注释
- [x] 1.3 确认 `settings.py` 的 `email_enabled` 默认值语义（SMTP 凭据齐全才真正发，否则 LogNotifier 兜底）

## 2. dida 书签标题 md 拆分（source-parsing）

- [x] 2.1 `domain/policy/urls.py` 新增纯函数 `extract_url_and_title(title, content) -> tuple[str|None, str]`，复刻老 dispatcher 4 分支（md 链接→干净 title / 裸 url→空 title / content 含 url→用 title / 无→(None,None)）
- [x] 2.2 新增 `tests/unit/domain/policy/test_urls.py`，覆盖 4 种 title/content 组合 + 边界
- [x] 2.3 `plugins/sources/dida.py` 改用 `extract_url_and_title`，入队 `title=clean_title or url`
- [x] 2.4 跑 `pytest tests/unit/domain/policy/test_urls.py` 绿 + CHANGELOG

## 3. text→flomo 智能标签（dispatch-tagging）

- [x] 3.1 `infrastructure/llm.py` 的 `except Exception: return []` 加 `log.warning`（补 GLM 静默失败可见性）
- [x] 3.2 `workers/runner.py` 新增 `_make_process_text(http, flomo, llm_key)`：无 tags 时 `generate_smart_tags` + `fmt_flomo_tags` 拼前缀
- [x] 3.3 `run_worker` 中 text 走 `_make_process_text`（file 保持直接 dispatch）
- [x] 3.4 新增/扩展 runner 单测：text 无标签生成拼接 + GLM 失败兜底不加前缀
- [x] 3.5 跑相关 pytest 绿 + CHANGELOG

## 4. Telegram 同步报告通道（notification-report）

- [x] 4.1 新增 `notifications/telegram_notifier.py`：`TelegramNotifier(bot_token, chat_id)`，`notify(message)` 调 `sendMessage`，失败不抛（附加通道）
- [x] 4.2 `infrastructure/scheduler.py` `_notify_results`：读 channels notification 段，构建 TelegramNotifier，total>0 时双通道发
- [x] 4.3 新增 telegram_notifier 单测（mock httpx，验证 sendMessage 调用 + 失败兜底）
- [x] 4.4 跑相关 pytest 绿 + CHANGELOG

## 5. Email 通道改 smtplib（notification-report）

- [x] 5.1 重写 `notifications/email_notifier.py`：用 stdlib `smtplib`（`asyncio.to_thread` 包异步）直连 QQ SMTP，移除 agently-cli/node 依赖
- [x] 5.2 SMTP 凭据缺失时跳过 + 日志（不崩，对齐附加通道）
- [x] 5.3 新增 email_notifier 单测（mock smtplib，验证发送 + 凭据缺失跳过）
- [x] 5.4 跑相关 pytest 绿 + CHANGELOG

## 6. 对等 checklist（browser-collect-parity）

- [x] 6.1 产出 `docs/parity-checklist.md`：inbox_dispatcher → inbox-server 逐条对等（source / destination / 通知 / 标签 / 标题解析 / 限速 / DLQ 等）
- [x] 6.2 4 个 browser 源标注「架构断裂 / 拆后续 change」+ 给出 collect 挪 worker 的方案要点
- [x] 6.3 其余条目标注状态（已对等/缺失/配置缺失/待验证）+ 修复优先级
- [x] 6.4 CHANGELOG

## 7. 收尾验证

- [x] 7.1 全量 `pytest` 绿
- [x] 7.2 `openspec validate fix-parity-gaps` 通过
- [x] 7.3 CHANGELOG 汇总（按 `## 2026-06-28` 分组）
- [ ] 7.4 每组独立 commit（commit message 用 conventional commits 中文正文）
