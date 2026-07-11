# inbox-server — Agent 协作指南

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

> **分支定位**：`main` = **开发分支**（CI/CD 持续集成/构建，PR 合入即触发）；`release` = **稳定分支**（手动管理，不自动动）。
> **核心规则**：禁止直接在 `main` 改代码 → 所有改动走 feature 分支 + PR → **自动 code review（自验四件套）+ merge 到 main**。
> 历史先例：PR #1–#7 全部走此流程。

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
# ④ 推送并开 PR（target=main）
git push -u origin feat/xxx
gh pr create --base main --title "feat(xxx): 简述" --body "..."
# ⑤ 自动 code review（自验四件套全绿）+ merge 到 main
#    冲突解法（禁用 rebase）：本地 `git merge origin/main` 产生 merge commit 解冲突
# ⑥ merge 后删分支（merge commit 模式，禁用 squash/rebase）
gh pr merge --merge --delete-branch
```

### 3. Commit 规范

- 格式：`type(scope): 描述`（Conventional Commits），**描述与正文用中文**
- `type`：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf`
- 一事一 commit，不堆砌；每个 commit 可独立通过自验

### 4. PR 规范

- **target 永远是 `main`**（开发分支；`release` 稳定分支手动管，不在此流程）
- PR 前跑「自验四件套」全绿
- PR 描述含：改了什么 / 如何验证 / 关联 change（openspec）
- **PR 提交后自动 review + merge**：main 是开发分支（CI 把关），无需人工放行；`gh pr merge --merge --delete-branch`
- **🔴 禁用 `git rebase`，统一 `merge`**：PR merge 用 `--merge`（不用 `--squash`/`--rebase`）；分支同步/解冲突用 `git merge origin/main`，保留 merge commit 历史、不改写提交

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
7. **browser 源调试**：collect 的 error 藏在 `meta`（`browser_collected` log 只记 `enqueued`，失败看不出来）——调试查 `login_sessions` 表（`status`/`last_error`）+ collect 返回的 `meta`；`docker exec` 调试 worker 要带 `-e DISPLAY=:99`（worker 的 Xvfb）
8. **baseline 防重复**（新 source 启用）：跑 `scripts/init_<source>_baseline.py` 预填全量 → 避免首次 collect 全量重复 cubox。**部署顺序**：`stop worker → 跑 baseline 脚本 → start worker`（避免 collect 与脚本并发竞态致首次全量）
9. **B站双 source**：`bilibili`（我的收藏，fav `media_id`，翻页增量）+ `bilibili_toview`（稀后再看，无 `media_id`，credential 复用 `bilibili_creds`，独立 baseline）
10. **邮件通知用网易 163**（非 QQ）：`settings.smtp_host` 默认 `smtp.163.com`；`.env` 配 `INBOX_SMTP_PASS`（163 授权码）+ `INBOX_SMTP_USER`（163 邮箱）+ `INBOX_EMAIL_TO`（收件）
11. **browser 源凭据两类**：① **cookie 类**（zhihu `z_c0` / bilibili `SESSDATA`）→ `POST /login/{platform}/cookie`；② **session 类**（inoreader / youtube，全 storage_state）→ `scripts/import_credentials.py`（playwright `state-save` → vault）。db 在 docker（postgres 不暴露端口），本机连不到 → 凭据写入用 `docker compose cp state.json worker:` + worker 容器跑 inline python 连内部 db。persistent session 已登录可免手动登录
12. **inoreader 增量去重用 key**（DOM article id），非 url——baseline `save_known` 存 key（`{i["key"]}`），`new` 用 key 对比。改去重逻辑前**先确认 save 行存的是 key 还是 url**，避免误判（曾因此误报 bug）
13. **YouTube 双 playlist DOM 差异**：WL（稀后观看）用 `ytd-playlist-video-renderer`，LL（点赞）用 `#contents` 内 DIV——`_VIDEO_SELECT` 抓 `#contents a[href*="watch?v="]` 兼容两者。collect `goto networkidle` 后加 `wait_for_selector`（YouTube SPA 冷启动 DOM 渲染慢，不等会抓空 `enqueued {}`）
14. **consumer 限速**（link `120/6h` 窗口 + `480/日`，`runner.py` LIMITS）：**不消费时**查 redis `queue:link:ratelimit:*`（窗口 token >120 满）+ `queue:link:daily:*`（日计数）。**临时忽略限额**：`DEL queue:link:ratelimit:*`（清窗口 token，consumer 下次 `token_acquire` 成功立即消费，不动代码、不需 restart）

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **inbox-server** (1409 symbols, 2142 relationships, 66 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/inbox-server/context` | Codebase overview, check index freshness |
| `gitnexus://repo/inbox-server/clusters` | All functional areas |
| `gitnexus://repo/inbox-server/processes` | All execution flows |
| `gitnexus://repo/inbox-server/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
