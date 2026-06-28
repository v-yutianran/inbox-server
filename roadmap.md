# inbox-server Roadmap

> **来源**：`docs/optimization-plan.md`（代码质量）+ `docs/parity-checklist.md`（功能对等）
> **⚠️ 重要**：`optimization-plan.md` 写于 2026-06-27，其状态已**严重滞后**——P0 全部、P1 大部分在 2026-06-28 已实现但未回写文档。本 roadmap 的每一项 `[x]` 都有 `文件:行号` 代码证据，**以代码为唯一真相**，取代 optimization-plan 作为单点真相。
> **推进方式**：每项一个 feature 分支 + PR，禁止直接改 main（见 `CLAUDE.md` Git 工作流硬规则）。

## 图例

- `[x]` 已完成（附代码证据）｜ `[ ]` 待办 ｜ `⚙️` 待用户配置

---

## A. 功能对等残余（来源：`docs/parity-checklist.md`）

### A1. browser 源架构（架构已就绪，待逐个启用）

> parity-checklist 原文标「❌ 架构断裂」，但 2026-06-28 `browser-collect-worker` change 已把 browser collect 挪到 worker（Xvfb headed），架构断裂已修复。

- [x] 架构重构：browser collect 从 server `collect_job` 挪到 `runner._browser_collect_loop`（worker 有 Xvfb，headed 可过反爬）
- [x] 知乎：已启用（`collection_id` + `credential_name`），分页 + content.type 取 title 两个 bug 已修
- [ ] B站：`LoginStrategy` + `Scraper` 已就绪，待配凭据 + `channels.yaml` 取消注释
- [ ] inoreader：同上，待启用
- [ ] 油管（YouTube）：同上，待启用

### A2. 配置（待用户提供）

- [ ] ⚙️ QQ SMTP 授权码 `INBOX_SMTP_PASS`（缺失时邮件通知走 `LogNotifier` 兜底）
- [ ] ⚙️ Telegram 通知 chat_id `TELEGRAM_CHAT_ID`（缺失时跳过 Telegram 通道）

---

## B. 代码质量优化（来源：`docs/optimization-plan.md`，状态已实锤修正）

### P0 — Critical（✅ 全部已完成）

- [x] **P0-1 consumer graceful shutdown**
  - 证据：`workers/consumer.py:36,45,83`（`stop_event` + `while not stop_event.is_set()` + `_interruptible_sleep`）；`workers/runner.py:131,133`（`asyncio.Event()` + `loop.add_signal_handler(SIGTERM/SIGINT, stop_event.set)`）
- [x] **P0-2 BrowserPool context 上限（LRU 防内存泄漏）**
  - 证据：`infrastructure/browser/pool.py:20,32-34`（`MAX_CONTEXTS = 10` + `next(iter(self._contexts))` 淘汰最旧）

### P1 — Important（大部分已完成，剩 P1-6 部分待办）

- [x] **P1-3 orchestrator 拆分（SRP）**
  - 证据：browser collect 整个挪到 `runner._browser_collect_loop`（`runner.py:86`），`orchestrator.py` 只剩 `run_collect` 跑 API 源 —— SRP 通过"挪走"而非"内拆"达成
- [x] **P1-4 `parse_netscape_bookmarks` 改 generator**
  - 证据：`domain/policy/netscape.py:18,29`（`yield Bookmark`，已是迭代器）
- [x] **P1-5 `@asynccontextmanager` 封装 browser lifecycle**
  - 证据：`infrastructure/browser/playwright_runtime.py:38,40`（`@asynccontextmanager def browser_session()`）
- [ ] **P1-6 channels config Pydantic 化（部分完成）**
  - 已做：`config/channels.py:18` `ChannelEntry(BaseModel)`
  - 待做：`config: dict[str, str]`（`channels.py:22`）仍是裸 dict，未按 source 类型建具体模型（如 `TelegramConfig` / `ZhihuConfig`），`required_config` 启动时未 fail-fast 校验

### P2 — Suggestion（❌ 全部待办）

- [ ] **P2-7** consumer `consume` 10+ 参数 → 用 `QueueLimits` dataclass 封装（keyword-only）
- [ ] **P2-8** 测试 `asyncio.wait_for` 暴力取消 → 配合 P0-1 的 `stop_event` 精确停止（测试中 `wait_for` 仍有 2 处）
- [ ] **P2-9** structlog `contextvars.bind_contextvars`（绑定 source/queue 上下文，日志可追溯）
- [ ] **P2-10 mypy 硬门槛建**
  - 现状：`.github/workflows/ci.yml:28` `uv run mypy ... || true`（advisory，不阻断）
  - 目标：去掉 `|| true`，类型错误阻断合并

---

## C. 推进节奏（剩余项，建议 2 个 PR）

> optimization-plan 原估 ~10h / 4 个 PR 已不适用——P0、P1 多数完成。剩余仅 P1-6 + P2 系列，约 ~4h。

| 批次 | 项 | 预估 | 价值 | 建议分支 |
|------|-----|------|------|----------|
| 第一阶段 | P1-6（config 细化）+ P2-9（structlog contextvars） | ~1.5h | 可维护性 / 可观测性 | `refactor/pydantic-config-and-structlog-bind` |
| 第二阶段 | P2-7（QueueLimits）+ P2-8（测试 stop_event）+ P2-10（mypy 硬门槛建） | ~2.5h | 工程质量 | `chore/queue-limits-test-mypy-gate` |

每项 TDD：先写测试再改，改完 `uv run pytest tests/unit tests/integration` 全绿。

---

## D. 杂项

- [ ] `README.md` 当前为空，补项目说明 / 快速启动 / 架构图
- [ ] ⚙️ 启用 browser 源前需配齐凭据（`POST /login/{platform}/cookie`）
- [ ] `docs/optimization-plan.md` 状态已滞后，建议顶部加过时声明或归档（避免误导后续引用）
