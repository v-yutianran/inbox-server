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
- [x] B站：已启用（`bilibili` 我的收藏 fav `media_id` + `bilibili_toview` 稀后再看；翻页增量 + baseline 防重复，PR #13/#14/#15）
- [ ] inoreader：同上，待启用
- [ ] 油管（YouTube）：同上，待启用

### A2. 配置（✅ 已完成）

- [x] ⚙️ 网易 163 SMTP 授权码 `INBOX_SMTP_PASS`（用户已配，缺失时走 `LogNotifier` 兜底）
- [x] ⚙️ Telegram 通知 chat_id `TELEGRAM_CHAT_ID`（用户已配，已收到同步报告）

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
- [x] **P1-6 channels config Pydantic 强类型校验（启动 fail-fast）**
  - 证据：`config/channels.py` 新增 9 个 config 模型（6 source + 3 destination）+ name 路由 + `_validate_channel` + `load_channels` fail-fast（PR #5）

### P2 — Suggestion（✅ 全部已完成）

- [x] **P2-7** consumer 参数收敛为 `QueueLimits`（PR #4，`domain/models.py`）
- [x] **P2-8** 测试 `stop_event` 替代 `wait_for` 暴力取消（PR #4，`_run_until_stopped` helper）
- [x] **P2-9** structlog `bound_contextvars` 绑定上下文（PR #4，browser_collector per-source + runner component）
- [x] **P2-10 mypy 硬门槛建**（PR #7：`pyproject [tool.mypy]` 修通配置 + 修 16 类型错误 + CI 去 `|| true`）

---

## C. 推进节奏（✅ 全部完成）

P1-6 + P2-7/8/9/10 已分别通过 **PR #4**（workers: P2-7/8/9）+ **PR #5**（config: P1-6）+ **PR #7**（mypy: P2-10）合并到 main。每项 TDD + 自验全绿。

剩余：仅 A1 的 browser 源逐个启用（B站/inoreader/油管，待凭据）。

---

## D. 杂项

- [x] `README.md` 补全（PR #6：架构/启动/配置/API/凭据获取）
- [ ] ⚙️ 启用 browser 源前需配齐凭据（`POST /login/{platform}/cookie`）
- [x] `docs/optimization-plan.md` 顶部已加过时声明（PR #3）
