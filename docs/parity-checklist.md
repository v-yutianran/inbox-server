# inbox_dispatcher → inbox-server 功能对等 Checklist

> 对照老 dispatcher（`~/.claude/skills/inbox_dispatcher/`）逐条核对 inbox-server 的功能对等情况。
>
> **状态图例**：✅ 已对等 ｜ 🔧→✅ 本次修复（change: fix-parity-gaps）｜ ❌ 缺失/架构断裂 ｜ ⚙️ 配置缺失（待用户）｜ ❓ 待验证
>
> 本次 change 修复所有 🔧 项；❌ browser 源架构重构拆为独立后续 change。

## 1. Sources（来源收集）

| 来源 | 类型 | 状态 | 说明 |
|---|---|---|---|
| telegram | API | ✅ 已对等 | getUpdates long-poll + link/text/file 入队 |
| dida（滴答） | API | 🔧→✅ | 书签标题 md 残留已修（`extract_url_and_title`） |
| zhihu（知乎） | browser | ❌ 架构断裂 | 配置禁用 + collect 在 server 无 display → 拆后续 |
| inoreader | browser | ❌ 架构断裂 | 同上 → 拆后续 |
| bilibili（B站） | browser | ❌ 架构断裂 | 同上 → 拆后续 |
| youtube（油管） | browser | ❌ 架构断裂 | 同上 → 拆后续 |

## 2. Destinations（分发目标）

| 目标 | 内容类型 | 状态 | 说明 |
|---|---|---|---|
| cubox | link | ✅ 已对等 | 智能标签 + github 来源标签 |
| flomo | text | 🔧→✅ | 本次补智能标签（`_make_process_text`） |
| 坚果云 | file | ✅ 已对等 | webdav 上传 + 暂存清理 |

## 3. 通知（同步报告）

| 通道 | 状态 | 说明 |
|---|---|---|
| Telegram 报告 | 🔧→✅ | 本次新增 `TelegramNotifier`（复用 bot_token + `notification.telegram_chat_id`） |
| QQ 邮箱报告 | 🔧→⚙️ | 本次改 smtplib；待填 QQ SMTP 授权码（`settings.smtp_pass`） |
| 触发条件 | ✅ 已对等 | total>0 才发（对齐老 dispatcher） |

## 4. 智能标签

| 链路 | 状态 | 说明 |
|---|---|---|
| link→cubox | ✅ 已对等 | worker 消费时 `generate_smart_tags` |
| text→flomo | 🔧→✅ | 本次补 `_make_process_text` |
| GLM 失败可见性 | 🔧→✅ | 本次补 `log.warning`（原 `except: return []` 静默） |

## 5. 标题解析

| 来源 | 状态 | 说明 |
|---|---|---|
| telegram md 链接 | ✅ 已对等 | `extract_url_title_pairs` 剥离 md |
| dida md 链接 | 🔧→✅ | 本次修（`extract_url_and_title` 复刻老 dispatcher 4 分支） |

## 6. 限速 / 去重 / DLQ

| 能力 | 状态 | 说明 |
|---|---|---|
| 限速（6h 窗口 + 日限额 + 配额超停止） | ✅ 已对等 | link 120/6h+480日，text 25/6h+96日，file 1400/30min |
| 成功去重 | ✅ 已对等 | DedupStore |
| 死信队列（失败 3 次） | ✅ 已对等 | DLQ |

## 7. 调度 / 进程

| 能力 | 状态 | 说明 |
|---|---|---|
| 定时 collect（60min） | ✅ 已对等 | APScheduler AsyncIOScheduler |
| worker 常驻消费 | ✅ 已对等 | docker worker + Xvfb |
| graceful shutdown | ✅ 已对等 | SIGTERM/SIGINT |

---

## 8. 残余差距（拆后续 change）

### 8.1 browser 源架构（优先级：高，需独立重构）

**根因**：`collect_job` 在 server 容器，但 `infrastructure/browser/playwright_runtime.py` 硬编码 `headless=False`（知乎等平台检测 headless 反爬，必须 headed），而 **server 无 `DISPLAY`**，只有 worker 启动了 Xvfb（`export DISPLAY=:99`）。

**方案**：把 browser collect（zhihu/inoreader/bilibili/youtube）从 server 的 `collect_job` 抽到 worker（有 Xvfb），或给 server 容器加 Xvfb。涉及 server/worker 职责边界重构。

**启用前置**：
1. 架构重构（collect 挪 worker）
2. `channels.yaml` 取消注释 + 配 `collection_id` / `credential_name`
3. `POST /login/{platform}/cookie` 配代登录凭据（z_c0 / sessdata）

### 8.2 配置（优先级：中）

- **QQ SMTP 授权码**（`INBOX_SMTP_PASS`）—— 待用户提供；缺失时邮件通道走 LogNotifier 兜底
- **Telegram 通知 chat_id**（`TELEGRAM_CHAT_ID`）—— 待用户提供；缺失时跳过 Telegram 通道

---

**总结**：本次 `fix-parity-gaps` 修复 5 类问题（dida 标题、text 标签、Telegram 通知、邮件 smtplib、browser 架构规划），使 telegram/dida → cubox/flomo 链路 + 双通道通知对齐老 dispatcher。残余：4 个 browser 源架构重构（拆后续 change）+ 2 项用户配置（QQ 授权码、TG chat_id）。
