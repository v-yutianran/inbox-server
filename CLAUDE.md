# inbox-server — Claude Code 协作指南

> Python / FastAPI / asyncio / uv 私有化收件箱分发服务。**中文回复**。
> 本文件是项目规范 MOC，详细规划见 `docs/` 与 `openspec/`。

## 项目速览

| 项 | 内容 |
|----|------|
| 远程 | `git@github.com:fishyer/inbox-server.git`（GitHub） |
| 技术栈 | FastAPI · SQLAlchemy[asyncio] · Redis · APScheduler · Playwright(headed) · structlog · uv（Python ≥3.12） |
| 架构 | `server`（uvicorn + alembic 建表）/ `worker`（headed chromium + Xvfb）/ `postgres` / `redis`，见 `docker-compose.yml` |
| 数据流 | 收集（telegram / dida / 知乎 / inoreader / B站 / 油管）→ 入队 → 限速分发（cubox / flomo / 坚果云） |
| 包管理 | **uv**（禁用 pip/poetry）；`uv sync --dev` 装依赖 |

---

## 🔴 Git 工作流硬规则（最高优先级）

> **禁止直接在 `main` 分支改任何代码。所有改动走 feature 分支 + PR。**
> 项目已有先例：PR #1（`fix/parity-gaps`）、`feat/browser-collect-worker`。

### 1. 分支命名

`feat/*` · `fix/*` · `refactor/*` · `docs/*` · `test/*` · `chore/*`

### 2. 标准流程（每个任务都走）

```bash
# ① 开工前自检：绝不在 main 上动手
git branch --show-current          # 若输出 main → 必须先切分支

# ② 基于最新 main 开分支（本地 main 可能落后远程，必须 fetch）
git fetch origin
git checkout -b feat/xxx origin/main

# ③ 小步 commit（conventional commits + 中文正文，见下）
# ④ 推送并开 PR
git push -u origin feat/xxx
gh pr create --base main --title "feat(xxx): 简述" --body "..."
# ⑤ merge 后删分支
```

### 3. Commit 规范

- 格式：`type(scope): 描述`（Conventional Commits），**描述与正文用中文**
- `type`：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf`
- 一事一 commit，不堆砌；每个 commit 可独立通过自验

### 4. PR 规范

- **target 永远是 `main`**
- PR 前跑「自验四件套」全绿
- PR 描述含：改了什么 / 如何验证 / 关联 change（openspec）

---

## 自验四件套（PR 前强制全绿）

```bash
# 1. lint（ruff）
uv run ruff check src/inboxserver tests scripts

# 2. 单元 + 集成测试（跳过 e2e）
uv run pytest tests/unit tests/integration -m "not e2e" --tb=short

# 3. 类型检查（mypy，当前 advisory，见 roadmap P2-10 改硬门槛建）
uv run mypy src/inboxserver --ignore-missing-imports

# 4. e2e（需真实凭据 + chromium，手动跑，CI 不跑）
uv run pytest -m e2e
```

> CI（`.github/workflows/ci.yml`）在 push/PR 到 main 时自动跑 1-3。任一红灯不得上报完成。仅文档变更可跳过 1-3。

---

## 代码规范

| 维度 | 规范 |
|------|------|
| 分层 | `domain/policy`（纯逻辑，可单测）/ `infrastructure`（collectors·destinations·browser·queue·persistence·http·llm·scheduler）/ `api` / `workers` / `plugins`（login_strategies）|
| 数据持有 | `@dataclass`；决策结果用 `@dataclass(frozen=True)`（如 `RetryDecision`）|
| 契约 | `Protocol` + `@runtime_checkable` 定义插件接口（`Source` / `LoginStrategy`）|
| 并发 | 全 async；阻塞调用（subprocess / webdav）包 `asyncio.to_thread` |
| 返回值 | **异常代替 None 返回**（vault raise / scraper raise `LoginExpired`）|
| 注释 | 中文 docstring 解释 WHY |
| 日志 | structlog JSON；关键路径绑定上下文（见 roadmap P2-9）|
| 路径 | 包根 `src/inboxserver/`，import 用 `inboxserver.xxx` |

---

## spec-driven（OpenSpec）

- `openspec/specs/`：`dispatch-tagging` · `browser-collect-parity` · `notification-report` · `source-parsing`
- 新功能先写 `openspec/changes/<change>/`（proposal / design / tasks），实施完成后 archive 到 `changes/archive/`
- 实施遵循 `tasks.md`，逐项打勾

---

## 文档地图

| 文档 | 用途 |
|------|------|
| `roadmap.md` | 推进路线（功能对等残余 + 代码质量 P0-P2，带状态核对）|
| `docs/optimization-plan.md` | 代码质量优化详案（Effective Python / Clean Code 审查）|
| `docs/parity-checklist.md` | 老 dispatcher → inbox-server 功能对等核对 |
| `CHANGELOG.md` | 每日变更（按 `## yyyy-MM-dd` 分组，含改了什么 + 如何验证）|
| `openspec/` | spec 与 change 归档 |

---

## 工作原则

1. **编码前思考**：列假设、简方案先提、不清楚就问；不静默挑选解读
2. **精准改动**：每行可追溯到请求，不改无关代码；匹配现有风格
3. **小步 + 验证**：改一点验一点，循环到绿；验证脚本/用例入库
4. **CHANGELOG 必记**：验证通过的改动记入 `CHANGELOG.md`（改了什么 + 如何验证）

---

## 注意事项

1. **本地 main 易落后远程**：开分支务必 `git fetch origin` 后基于 `origin/main`，不要基于可能过时的本地 main
2. **worker 必须 headed**：`playwright_runtime` 硬编码 `headless=False`（知乎等平台检测 headless 反爬），worker 靠 Xvfb 提供 `DISPLAY=:99`
3. **runner 作 PID1**：worker 容器用 `exec` 让 runner 成为 PID1，信号直达 → graceful shutdown；不要用 `xvfb-run` 包 PID1（会吞子进程）
4. **env 前缀 `INBOX_`**：pydantic-settings 读取，配置见 `.env` / `.env.example`
5. **`channels.yaml` 是配置单一数据源**：来源启用 / 分发目标 / 限速参数集中于此，server 与 worker 共享（只读挂载）
6. **alembic 管生产 schema**：server 启动先 `alembic upgrade head`，lifespan `create_all` 仅兜底；schema 改动必须生成迁移
