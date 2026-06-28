# CHANGELOG

## 2026-06-28

### docs：CLAUDE.md 沉淀会话经验 + 脚本部署顺序 + roadmap B站标记

本次会话经验沉淀（方便复用）：
- **CLAUDE.md 注意事项补 4 条**：① browser 源调试（collect error 藏 `meta`，查 `login_sessions` 表；`docker exec` 带 `-e DISPLAY=:99`）② baseline 防重复（新 source 跑 init 脚本预填，部署顺序 `stop worker → 脚本 → start`）③ B站双 source（`bilibili` 我的收藏 fav `media_id` + `bilibili_toview` 稀后再看）④ 邮件通知用网易 163（非 QQ）
- **`scripts/init_bilibili_baseline.py` docstring**：固化部署顺序（`stop worker → run 脚本（Xvfb）→ start worker`），避免与 worker collect 并发竞态致首次全量重复
- **roadmap B站标 `[x]`**：已启用（fav + 稀后再看 + 翻页增量 + baseline 防重复）

---

### feat(bilibili)：baseline 初始化脚本（B站全量 → 填 baseline，不 cubox）

新增 `scripts/init_bilibili_baseline.py`：从老 dispatcher（或首次启用）切换到 inbox-server 时，
调 B站 API 全量抓（「我的收藏」fav 翻页 + 「稍后再看」toview）→ 填 `incremental_baselines`
（bilibili + bilibili_toview 的 known_keys，url）→ **不 cubox**。

之后 worker collect 只推**增量**（新增才 cubox），不重复老 dispatcher 已导入 cubox 的。

**跑法**（worker 容器，有 chromium + Xvfb）：
```
docker compose exec -e DISPLAY=:99 worker uv run python scripts/init_bilibili_baseline.py
```

**如何验证**：脚本输出 `✓ bilibili baseline: <N> 条` + `✓ bilibili_toview baseline: <N> 条`；
之后 worker collect `enqueued bilibili {}`（无新增，baseline 已全量）。

---

### feat(bilibili)：新增「稍后再看」source（bilibili_toview）

新增 `BilibiliToviewSource`（独立于「我的收藏」BilibiliSource）：
- 抓 `/x/v2/history/toview/web`（无分页全量 ~349）→ bvid → 入队 link
- 独立 baseline（`bilibili_toview`，与 fav 分开）；credential 复用 `bilibili_creds`，platform 复用 `bilibili`（同 SESSDATA cookie）
- `channels.py` 加 `BilibiliToviewSourceConfig(credential_name)`（P1-6 校验，无 media_id）+ 路由
- `browser_collector.py` fetch sources 循环加 `bilibili_toview`（同 bilibili：Scraper fetch_via_page + cast(Source)）
- 单测：parse + collect 增量去重 + 独立 baseline 验证

**如何验证**：`uv run pytest tests/unit/plugins/test_bilibili_toview_source.py` → 4 passed；全量 151 passed 无回归

---

### feat(bilibili)：collect 翻页增量（pn 循环 + 整页 known 停）

`BilibiliSource.collect` 之前只抓第一页（`pn=1, ps=20`，20 条），新增 >20 或在第 2 页后漏抓。改为翻页（pn=1..MAX_PAGES，复刻 zhihu 范式）：
- 每页 parse + 增量去重（baseline known），**整页全 known 则停**（新收藏在前，旧页全是已知）
- 空页（抓完）停；`MAX_PAGES=500` 防无限（默认收藏夹 2508 条 ≈ 126 页）
- 加单测：翻页到空页停 + 翻页到整页 known 停（增量验证）

**如何验证**：`uv run pytest tests/unit/plugins/test_bilibili_source.py` → 4 passed（含 paginate）；全量 147 passed 无回归

---

### fix(bilibili)：B站收集链路修复（example 模板 + worker Xvfb lock 根因）

验证 B站收藏流程时发现并修复 2 个问题：

1. **`channels.yaml.example` 补 bilibili 模板**：原文档缺 bilibili 模板，用户照 zhihu 误用 `collection_id`（BilibiliSource 实际读 `media_id`）→ KeyError。补 bilibili 模板（`media_id`，注释标明非 collection_id）
2. **`docker-compose.yml` worker Xvfb lock 修复（根因）**：worker 重启时 `/tmp/.X99-lock` 残留 → 新 Xvfb「Server is already active」起不来 → chromium 无法 launch → 所有 browser 源 collect 静默失败。command 前加 `rm -f /tmp/.X99-lock /tmp/.X11-unix/X99`

**如何验证**（端到端跑通）：
- POST `/login/bilibili/cookie`（SESSDATA）+ channels.yaml 启用 bilibili（`media_id=994333594`）
- force-recreate worker（清残留 lock）→ bilibili collect 抓 **20 条**收藏入队 link
- consumer 消费 → **17 条 cubox POST 200 OK**；`/queue` link `done=84`

---

### security：开源前脱敏 settings.py（移除硬编码真实邮箱）

开源准备：`settings.py` 的 `email_to` 默认值含真实 QQ 邮箱，属源码常量（.gitignore 管不到），开源会泄露。

- `email_to` 默认值 → `""`（部署者 `.env` 配 `INBOX_EMAIL_TO`）
- 注释里的真实邮箱移除；「QQ SMTP」注释改中性（实际默认网易 163）
- `test_email_notifier` 用 monkeypatch mock `email_to`，改默认值不影响测试

**如何验证**：ruff / mypy passed；pytest **146 passed**；grep 真实邮箱 = 0

> ⚠️ 历史 2 个 commit（54311f4/485c46f）的 settings.py 仍含旧邮箱，开源前需 `git filter-repo` 清理历史（见后续）。

---

### docs：CLAUDE.md 固化「禁 rebase，统一 merge」工作流

用户偏好纠正：曾用 `git rebase` 解冲突 + `gh pr merge --squash`，现统一为 merge。

- **PR merge 用 `gh pr merge --merge`**（merge commit），禁用 `--squash` / `--rebase`
- **分支同步/解冲突用 `git merge`**（产生 merge commit），禁用 `git rebase`（保留完整历史、不改写提交）
- 已同步记入 memory（跨会话）+ 本项目 CLAUDE.md Git 工作流

---

### chore(ruff)：清理 main 既有 5 个 lint errors（CI ruff step 转绿）

main 既有 5 个 ruff errors（PR #4 标注过，非任一功能 PR 引入），致 CI ruff step 一直红。本次清零：

- **I001 import 组织**：`zhihu.py`（`ruff --fix` 自动）
- **E501 长行拆分**：`settings.py:32` / `dida.py:51`（注释换行）、`zhihu.py:45,96`（f-string 括号续行，不改逻辑）

**如何验证**：
- `uv run ruff check src/inboxserver tests scripts` → **All checks passed**（0 error）
- `uv run mypy src/inboxserver` → Success（0 issue）
- `uv run pytest tests/unit tests/integration` → **146 passed**
- CI 三关（ruff / mypy / pytest）首次全绿

---

### docs：更新 CLAUDE.md 工作流 + roadmap 状态

- **CLAUDE.md Git 工作流**：明确 `main`=开发分支（CI/CD 持续集成/构建）、`release`=稳定分支（手动管理）；PR 提交后**自动 code review + merge**（无需人工放行，`gh pr merge --squash --delete-branch`）
- **roadmap**：P1-6 / P2-7/8/9/10 标 `[x]`（PR #4/#5/#7 已完成）；A2 邮箱改网易 163（用户已配）+ TG chat_id 标完成

---

### refactor(workers)：consume 收 QueueLimits + 测试 stop_event + structlog 上下文绑定

P2-7/P2-8/P2-9 三项 workers 层打磨（来自 `docs/optimization-plan.md`）：

1. **P2-7 consume 参数收敛**：`QueueLimits` dataclass 从 `workers/runner.py` 上提到 `domain/models.py`；`consume` 的 `window_count/window_sec/daily_limit/interval` 4 散参收敛为单个 `limits: QueueLimits`；runner 调用方直接传 `lim`
2. **P2-8 测试改 stop_event**：6 处 `asyncio.wait_for(consume(...), timeout)` 超时暴力取消 → `stop_event.set()` 优雅停止（避免 in-flight item 半处理）；抽 `_run_until_stopped` helper 消除 5 处样板
3. **P2-9 structlog 上下文绑定**：`browser_collector` 每个 source 循环 `bound_contextvars(source=name)`、`runner._browser_collect_loop` 绑 `component="browser_collect"`，source 插件内部日志自动带上下文（`merge_contextvars` 已配）

**如何验证**：
- `uv run ruff check`（改的 6 文件）→ All checks passed
- `uv run pytest tests/unit tests/integration` → **140 passed**（无回归）
- consume graceful shutdown 行为不变（stop_event 模式测试覆盖 OK/QUOTA/FAIL→DLQ/去重/graceful）

> 注：全量 ruff 仍有 6 个 errors（settings/dida/zhihu×3 等），均 main 既有、非本 PR 引入，见 PR 说明。

---

### chore(mypy)：修通 mypy 配置 + 修 16 类型错误，CI 改硬门槛建（去 `|| true`）

P2-10（来自 `docs/optimization-plan.md`）：mypy 从 advisory（`|| true`）改硬门槛建。

**根因**：mypy 因 src layout 路径重复（`src.inboxserver.x` vs `inboxserver.x`）跑不起来，CI 的 `|| true` 掩盖了问题——和 main 既有的 6 个 ruff errors 同属「质量门槛建形同虚设」。

**改动**：
- `pyproject.toml` 加 `[tool.mypy]`：`mypy_path="src"` + `explicit_package_bases=true` + `ignore_missing_imports=true`（修通路径，可直接 `mypy src/inboxserver`）
- `.github/workflows/ci.yml`：mypy 去 `|| true` + 去命令行 `--ignore-missing-imports`（pyproject 已配），变硬门槛建
- 修 16 类型错误（8 文件，**全部真修非 `type:ignore`**）：`browser_collector`（_BrowserDeps 字段 object→具体类型 TYPE_CHECKING + source 构造 `cast(Source)`）、`urls.py`（签名第二位 `str`→`str|None`，docstring/测试要求返回 None）、`db.py`（`get_session` 返回 `AsyncIterator[AsyncSession]`）、`orchestrator.py`（dida src 改名避免类型合并）、login_strategies（storage_state `{**...}` 解包为 dict）、sources（`seen: set[str]` 注解）

**如何验证**：
- `uv run mypy src/inboxserver` → **Success: no issues found in 84 source files**（0 error）
- `uv run pytest tests/unit tests/integration` → **140 passed**（无回归）
- `uv run ruff check`（改的 9 文件）→ All passed（全量 main 既有 6 errors 非本 PR 引入）

---

### docs：新增 roadmap.md 与 CLAUDE.md，建立 GitHub PR 工作流硬规则

为项目建立可执行的协作规范与推进路线图，并固化 git 工作流：

1. **roadmap.md（新建）**：整合 `docs/optimization-plan.md` + `docs/parity-checklist.md`，逐项 grep 实锤代码状态。**修正 optimization-plan 状态滞后**——P0 全部、P1 大部分（P1-3/4/5）已于 2026-06-28 代码实现但未回写文档；roadmap 每项 `[x]` 附 `文件:行号` 证据，取代 optimization-plan 作为单点真相
2. **CLAUDE.md（新建）**：项目协作指南。🔴 Git 工作流硬规则（禁止直接改 main，feature 分支 + PR target=main）+ 自验四件套（ruff/pytest/mypy）+ DDD/asyncio 代码规范 + spec-driven 引用
3. **optimization-plan.md**：顶部加「已过时」声明，指向 roadmap 为准（避免后续误导）
4. **CHANGELOG.md**：记录本次变更（落地新立的「CHANGELOG 必记」规范）

**如何验证**：
- `git branch --show-current` = `docs/roadmap-and-claude-md`（基于 `origin/main`，未污染 main）
- roadmap 复选框：7 项已完成（每项附代码证据）/ 13 项待办
- CLAUDE.md 硬规则自检：`grep` 命中 `禁止直接在` / `target 永远是` / `origin/main`
- optimization-plan.md 顶部含「已严重滞后」声明 + 指向 `../roadmap.md`

---

### refactor(config)：channels config Pydantic 强类型校验（启动 fail-fast）

P1-6（来自 `docs/optimization-plan.md`）：补充 channels config 的内部字段校验。

`ChannelEntry` 已是 Pydantic BaseModel（顶层字段校验已有），但 `config: dict[str,str]` 内部不校验，缺字段要到 source 构造时才 KeyError（隐蔽故障）。

**改动**（方案 C：加校验层，不改各 source 的 `config["key"]` 接口）：
- 新增 9 个 config 模型（6 source + 3 destination）：`TelegramSourceConfig`/`DidaSourceConfig`/`ZhihuSourceConfig`/`BilibiliSourceConfig`/`InoreaderSourceConfig`/`YoutubeSourceConfig` + `CuboxDestinationConfig`/`FlomoDestinationConfig`/`JianguoyunDestinationConfig`
- name → 模型路由 dict；`_validate_channel` 按 name 选模型校验 config
- `load_channels` 解析后对 enabled 渠道 fail-fast 校验（缺字段抛 ValueError，带渠道名 + 明细）
- 未注册模型的渠道（自定义插件）跳过校验，保持扩展性

**如何验证**：
- `uv run ruff check` → All passed
- `uv run pytest tests/unit tests/integration` → **146 passed**（新增 6 个校验测试）
- 各 source 接口零改动（仍 `config["key"]`，启动已保证字段存在）

> 方案 C（Pydantic 校验 + 不改 source 接口），非 optimization-plan 原意的「config 字段直接用模型类型」。理由：最小侵入、行为等价、避免改 9 个插件构造签名。详见 PR 说明。

---

### docs(readme)：补全 README（架构/启动/配置/API/测试/凭据获取）

`README.md` 原为空，补全为可上手的项目文档：

- **架构**：四服务（postgres/redis/server/worker）职责 + 数据流
- **快速启动**：`cp .env` / `channels.yaml` → `docker compose up`
- **配置**：`.env` 关键变量（`INBOX_MASTER_KEY` / `INBOX_ADMIN_API_KEY` / 业务凭据，核对自 `.env.example`）+ `channels.yaml` 说明
- **API 端点**：8 个（healthz/readyz/sync/queue×2/channels/login×2）+ 鉴权 `X-API-Key`
- **测试命令**：ruff / pytest / mypy
- **凭据获取**：QQ SMTP 授权码 / TG chat_id / browser 源 cookie 的获取方式（需用户填值）

> 变量名核对自 `.env.example`（`INBOX_ADMIN_API_KEY` 非 `INBOX_API_KEY`、GLM 是 `Z_AI_API_KEY`、有 `INBOX_MASTER_KEY`）。

---

### fix-parity-gaps：修复 inbox-server 与老 dispatcher 的 5 类功能差距

经对照老 dispatcher（`~/.claude/skills/inbox_dispatcher/`）发现 inbox-server 复刻不完整，修复 5 类已确认问题：

1. **text→flomo 智能标签缺失**：`workers/runner.py` 新增 `_make_process_text`，消费 text 时调 `generate_smart_tags` + `fmt_flomo_tags` 拼 `#标签` 前缀，对齐老 dispatcher `process_text`
2. **Telegram 同步报告通道缺失**：新增 `notifications/telegram_notifier.py`（复用 telegram bot_token + `channels.yaml` notification 段的 chat_id）；`scheduler.py` `_notify_results` 改双通道
3. **QQ 邮箱报告失效**：`email_notifier.py` 从 agently-cli（容器无 node + 凭据在 macOS keychain，容器不可用）改 stdlib `smtplib` 直连 SMTP（实测网易 163 发件 → QQ 收件；`asyncio.to_thread` 异步，不阻塞 loop）
4. **dida 书签标题残留 md**：`domain/policy/urls.py` 新增 `extract_url_and_title`（复刻老 dispatcher 4 分支），`plugins/sources/dida.py` 改用，剥离 `[标题](url)` 得干净标题
5. **browser 源架构断裂**：`docs/parity-checklist.md` 记录根因（collect 在 server 无 display + `playwright_runtime` 硬编码 `headless=False`）与方案（collect 挪 worker），启用拆后续 change
6. **GLM 静默失败补可见性**：`infrastructure/llm.py` 的 `except: return []` 加 `log.warning`（修"无标签且无日志"隐患）

**配置改动**：`config/settings.py` 加 `smtp_*`（移除 agently_cli_path）、`channels.yaml` 加 `notification` 段、`config/channels.py` 解析 `notification` 字段。

**如何验证**：
- `uv run pytest tests/` → **138 passed, 1 deselected**（新增 `test_urls` / `test_runner_text` / `test_telegram_notifier` / `test_email_notifier`）
- dida 标题：`[文本](url)` → cubox 标题「文本」（`test_euat_md_link`）
- text 标签：无 tags → flomo 收到「#标签 内容」（`test_process_text_generates_and_prepends_tags`）
- `openspec validate fix-parity-gaps` 通过；完整对照见 `docs/parity-checklist.md`

**残余**（拆后续 change）：4 个 browser 源（知乎/B站/inoreader/油管）架构重构 + 启用；QQ SMTP 授权码（`INBOX_SMTP_PASS`）、Telegram 通知 chat_id（`TELEGRAM_CHAT_ID`）待用户配置。

---

### 修复 worker 僵尸容器故障（分发瘫痪 9+ 小时，三层叠加 bug）

测试服务时发现 worker 容器"假健康"（Up 但 python 进程死了 9 小时），scheduler 持续入队但 worker 0 消费，积压无限增长。根因是三个独立 bug 叠加：

**根因链**：
1. **webdav3 依赖缺失**：`jianguoyun.py` `from webdav3.client import Client`，但 pyproject 未声明 `webdavclient3` → `build_destinations` 构建坚果云 destination 时 ModuleNotFoundError → runner 启动即崩（单测用 mock webdav_client，漏过真实依赖路径）
2. **.venv 符号链接断链（镜像构建污染）**：无 .dockerignore，Dockerfile `COPY . .` 在 `uv sync` 之后，把宿主 macOS .venv（`.venv/bin/python → cpython-3.12-macos-aarch64`）覆盖镜像里刚建的 Linux .venv → 运行时容器断链
3. **xvfb-run 作 PID1 不产生持久子进程**：xvfb-run 的 sh 作为容器 PID1 时，其 python 子进程不持久（手动 docker exec 同命令能跑，PID1 却不行——进程组/信号差异）；uv run 在 xvfb-run 下同样不持久

**修复**：
- `pyproject.toml` + `uv.lock`：`uv add webdavclient3`（补漏依赖）
- `.dockerignore`（新建）：排除 .venv / __pycache__ / .pytest_cache / .env / *.db / .git / tmp，防止宿主产物污染镜像
- `docker-compose.yml` worker command：`xvfb-run uv run python` → `sh -c "Xvfb :99 ... & export DISPLAY=:99 && exec /app/.venv/bin/python -m ...runner"`，让 runner 直接成为 PID1（信号直达，graceful shutdown 正常）

**如何验证**：
- worker 进程：PID 1 = `/app/.venv/bin/python -m inboxserver.workers.runner`（exec 替换 sh），Xvfb 后台子进程，30s+ 持续稳定不崩、无重启
- `.venv/bin/python` 链接：`/usr/bin/python3.12`（Linux，不再 macOS 断链）
- 积压：link done 7 / text done 2 全部消费完成，pending 0；新入队被持续消费
- webdav3 依赖加载（logs 见 webdav3/urn.py import warning，证明已装）

**防御加固**（防僵尸容器复发）：
- `docker-compose.yml`：server/worker 加 `restart: unless-stopped`；worker 加进程级 healthcheck（`pgrep -f workers.runner`，runner 作 PID1 崩即容器停 + 自动重启）
- `runner.py`：加 structlog `worker_started` 启动日志（JSON 输出 stdout，可观测性，替代原 print）
- 验证：worker Health=healthy、worker_started 日志可见 `{"destinations":["link","text","file"],"event":"worker_started",...}`、积压持续消化

## 2026-06-27

### 实现 skill 文档列出的全部规划 API 端点（4 类 5 个，从规划变事实）

skill 文档列了 9 端点但实际只 3 个（healthz/readyz/sync），其余 /queue、/queue/dlq、/channels、/login/{platform}/* 全 404。本次把 5 个规划端点真实实现。

**改了什么**：
- 新增 `api/routes/queue.py`：GET /queue（三类队列 pending/dlq/done 计数）、GET /queue/dlq（死信内容）
- 新增 `api/routes/channels.py`：GET /channels（脱敏渠道列表，绝不暴露 token/credentials/llm）
- 新增 `api/routes/login.py`：POST /login/{platform}/cookie（Fernet 加密落库，name={platform}_creds）、GET /login/{platform}/status（读 login_sessions 表）
- `infrastructure/queue/repository.py`：加 `peek_dlq(kind)`（对称 peek_all）
- `api/app.py`：include_router 挂载 3 个新路由；5 个端点全部挂 require_api_key（health 不变）
- 新增 `tests/integration/test_management_endpoints.py`（6 个端点集成测试）

**关键设计**：
- name 约定 `{platform}_creds`：与 channels.yaml credential_name + scripts/import_credentials.py 对齐，session_manager.acquire 据此取用
- POST /login 不触发浏览器验证：server 容器无 chromium（只在 worker），登录态由 worker collect 时自然建立
- /channels 严格脱敏：只返 enabled/kind/item_kind/credential_name，config 里 token/webhook 不透出

**如何验证**：
- `uv run pytest tests/unit tests/integration -q` → **120 passed**（新增 6 端点集成测试：队列计数/死信/脱敏/写凭据加密/校验/鉴权）
- `uv run ruff check src tests` → All checks passed
- docker 重建后 curl 5 端点全 200；`openapi.json` 路由从 3 → 8；无 key/错 key → 401

## 2026-06-26

### 阶段1:工程骨架 + domain policy 纯函数 + TDD

- **工程初始化**:`uv init --lib --package` 创建 `~/project/inbox-server`(Python 3.12, uv_build, src 布局)
- **DDD 分层目录**:`domain/policy`(纯函数) + `infrastructure/{collectors,destinations,queue,browser,persistence,http_client,llm,scheduler}` + `api/routes` + `workers` + `plugins/{sources,destinations,login_strategies}` + `notifications` + `tests/{unit,integration,e2e}`
- **domain/policy 纯函数**(迁移自 inbox_dispatcher 核心算法,算法与 IO 分离):
  - `ratelimit`:固定窗口令牌桶(`token_bucket_key`/`bucket_ttl=window+100`/`is_within_rate`)
  - `daily_limit`:按日分桶(`daily_key` 含 `%Y%m%d`/`daily_ttl=90000` 跨天清零)
  - `dedup`:指纹(`link=url`/`text=md5`/`file=remote_name`)+ `done_key` + `DONE_TTL=604800`
  - `retry`:三路决策(`decide_on_success`/`decide_on_quota`/`decide_on_failure`,**配额超不计 retry 不进 DLQ**,失败满 3 次进 DLQ)
  - `tags`:`clean_tag`(去空格/#/标点)/`fmt_cubox_tags`(数组,is_github 前置 github)/`fmt_flomo_tags`(#tag 空格分隔)
  - `smart_tags`:`build_glm_prompt`(3个2-6汉字标签强约束)/`parse_glm_response`(切分+清洗+前3个len>=2)
  - `netscape`:`parse_netscape_bookmarks`(正则+html.unescape → [Bookmark])
- **domain/models**:`ItemKind(StrEnum: link/text/file)` / `Bookmark(url,title)` / `QueueItem(kind,payload,retry)`
- **config**:`settings.py`(pydantic-settings, INBOX_ 前缀) + `logging.py`(structlog JSON)
- **验证**:`uv run pytest tests/unit/domain -v` → **36 passed in 0.02s**;`uv run ruff check src/inboxserver` → All checks passed

### 阶段2:destinations + queue Repository + notifications

- **infra/queue**(IO 层,调 domain.policy 纯函数算 key/ttl):`RedisQueueRepository`(LPUSH/RPOP FIFO + requeue/dlq/peek/clear,键按内容类型) + `DedupStore`(SET ex=7天,scan 统计) + `RateGuard`(token_acquire INCR+EXPIRE window+100 / daily_incr 25h TTL)
- **plugins**:`contracts.py`(Destination Protocol + DispatchOutcome:OK/QUOTA/FAIL) + destinations/`cubox`(200→OK/-3030→QUOTA/非JSON兜底HTTP status)/`flomo`(code0→OK)/`jianguoyun`(WebDAV,webdav_client 可注入 mock) + `registry.py`(entry_points 主 + 内置兜底)
- **infra**:`http_client.py`(httpx 工厂) + `llm.py`(GLM 智能标签 IO,prompt/解析走 domain/policy/smart_tags) + **notifications**:`Notifier` Protocol + `LogNotifier`(structlog 兜底)
- **依赖**:+redis/httpx(主) +respx(测试);conftest 提供 `fake_redis`(fakeredis FakeAsyncRedis)
- **验证**:`uv run pytest tests/unit` → **58 passed in 0.21s**;`uv run ruff check src tests` → All checks passed
- **命门测试**:`test_cubox_quota_minus_3030`(目的地识别配额) + `test_quota_stops_without_counting_retry`(重试不计 retry) 锁死配额处理链路;`test_requeue_defers_after_existing` 澄清 LPUSH/RPOP 语义(失败项排到现有项之后重试)

### 阶段3:代登录子系统 + 知乎浏览器源（单测完成，e2e 待真实 z_c0）

- **persistence**:`Base`/`db`(async engine)/`models`(7 张 ORM 表:telegram_offsets/dida_sync_states/login_sessions/credentials/incremental_baselines/sync_jobs/subscriptions,通用类型 PG/sqlite 皆可)/`crypto/vault`(Fernet + Scrypt 派生 key)/repositories(credential+login_session+baseline)
- **browser 命门**:`playwright_runtime`(单例 chromium headless --no-sandbox)/`pool`(context_for 缓存 + new_context 一次性 + invalidate)/`session_manager`(acquire 三态判定:active+未过期+validate 通过→复用,否则 refresh 重登)/`scraper`(页面内 evaluate fetch,401→LoginExpired)/`login_strategies/zhihu`(z_c0 cookie 注入→storage_state,validate 探测收藏 API)
- **plugins**:`contracts` 增 Source/SourceKind/CollectResult + LoginStrategy Protocol;`sources/zhihu`(`parse_zhihu_collections` 纯函数 + ZhihuSource:代登录抓收藏→解析→增量去重→智能标签→入队 link,401 自动重登)
- **conftest**:增 `db_session` fixture(sqlite 内存,建全部表,零外部依赖)
- **依赖**:+sqlalchemy[asyncio]/asyncpg/alembic/cryptography/playwright +aiosqlite(dev)
- **验证**:`uv run pytest tests/unit` → **91 passed**(domain 36 + infra 36 + plugins 19);`ruff check` All checks passed(2 个 respx httpx client ResourceWarning 为测试框架噪音,生产无影响)
- **命门测试覆盖**:session_manager 三态(有效复用/过期重登/validate 失败重登) + zhihu validate(200/401/异常) + scraper 401→LoginExpired + credential vault 错密钥 InvalidToken(客户隔离) + zhihu source 增量去重 + 401 重试

### 阶段3 命门 e2e 验证 ✅ 通过

- **命门判决**:`/api/v4/me` 返回 200 + 真实登录用户(fishyer) → **Python playwright + storage_state(注入 z_c0)能拿到知乎登录态,商业化代登录路线成立**
- **诊断修正**(e2e 调试中定位):
  - validate 端点从 `/api/v4/collections`(GET 405)改 `/api/v4/me`(稳定登录验证)
  - goto 从 `networkidle`(知乎持续请求易超时)改 `domcontentloaded`(me 端点只需 cookie)
  - z_c0 cookie 加 `expires`(持久化,session cookie 经 storage_state 往返不稳)
  - 收藏 API 真实路径 `/api/v4/collections/<id>/items`(参考 export_zhihu.mjs)
  - **关键发现**:z_c0 必须原始值(state.json 187 字符),`playwright-cli cookie-get` 会 URL 编码 `|`(267 字符)致失效;production 客户手动复制浏览器 cookie 是原始值,无此问题
- **验证**:单测 91 passed + e2e 命门 1 passed + ruff All checks passed
- **headed 强制(硬性要求)**:`playwright_runtime` 硬编码 `headless=False`,移除 `browser_headless` 配置项——全工程零 headless 路径,任何场景都用 headed(知乎等平台检测 headless 反爬)。容器部署需 xvfb-run。e2e headed 验证通过(me 200)
- **待办**:login route(随阶段4 fastapi 一起)

### 阶段4:API源(Telegram/滴答) + FastAPI路由

- **persistence repos**:`telegram_offset`(update_id 游标,sha256 hash token)+ `dida_sync_state`(saved_titles 去重),取代文件状态
- **API 源**:`sources/telegram`(getUpdates long-polling offset+1 → 链接/md链接→link,纯文本→text,offset 持久化)+ `sources/dida`(inbox 全量→提取 url 入队→DELETE 任务+saved_titles 去重)
- **domain/policy/urls**:`extract_url_title_pairs`(md [title](url)+裸url)/`extract_first_url` 纯函数
- **FastAPI app**:`api/app.create_app` + lifespan(配 structlog)+ `main.py`(uvicorn 入口)
- **路由**:`/healthz`(存活)/`/readyz`(就绪)/`POST /sync`(加载 channels → orchestrator 跑启用 source → 返回入队摘要)
- **编排**:`collectors/orchestrator.run_collect`(按 channels 动态创建 telegram/dida source 实例 → collect;知乎浏览器源 TODO)
- **配置/鉴权/依赖**:`config/channels.load_channels`(yaml + ${ENV} 插值)+ `api/auth.require_api_key`(X-API-Key,未配置开放)+ `api/deps`(get_session/get_http/get_redis)
- **依赖**:+fastapi/uvicorn[standard];Depends 用 `Annotated[T, Depends()]`(规避 B008,FastAPI 最佳实践)
- **验证**:单测 91 + integration 3(healthz/readyz/sync 路由) = **94 passed**;ruff All checks passed
- **待办**:**sync 端到端(channels.yaml + respx mock telegram/dida 真实 collect 验证)** + **skill 切换为 curl POST /sync**(随阶段5 server 部署后切换)

### 阶段5:worker 消费 + docker-compose 部署 + e2e 补全

- **worker consumer**(`workers/consumer.py`):移植 worker.py 的 async 消费循环——每日限额→dequeue→去重→窗口限速→process→OK(mark_done+daily_incr)/QUOTA(requeue 停)/FAIL(retry≥3→DLQ)。基于 domain.policy 纯函数 + queue repos
- **destination dispatcher**(`infra/destinations/dispatcher.py`):按 channels 动态创建 destination 实例,按 item_kind 索引
- **worker runner**(`workers/runner.py`):三队列并发消费(asyncio.gather)+ 限速常量(link 120/6h+480日、text 25/6h+96日、file 1400/30min)
- **worker consume 测试**(4):OK→mark_done+daily_incr / FAIL 3次→DLQ / QUOTA→不进 DLQ / 去重跳过(均 fakeredis+mock process_fn,wait_for 超时取消无限循环)
- **sync pipeline e2e**(1):真实 telegram source(respx mock getUpdates)→入队→真实 consume→真实 cubox(respx mock)→mark_done。端到端闭环验证
- **部署**:`Dockerfile`(uv+playwright chromium+xvfb,headed 必备)+ `docker-compose.yml`(server/worker/postgres/redis 四服务,worker 用 `xvfb-run` 跑 headed)+ `channels.yaml.example` + `.env.example`
- **app lifespan**:加 `create_all`(MVP 建表,生产用 alembic)
- **修复**:vault 语义(显式空串不 fallback settings,算缺失→raise);conftest 测试环境切 sqlite+测试 master_key;DRY 删冗余 queue_key_helper
- **验证**:单测 91 + integration 8(api 3 + worker_consume 4 + sync_pipeline 1) = **99 passed**;ruff All checks passed
- **待办**:**scheduler**(APScheduler 60min collect,MVP 可用 docker cron/手动 curl /sync 替代) + **alembic 迁移**(取代 create_all) + **skill 切换为 curl POST /sync**(server 部署后) + **真实 docker-compose up 端到端验证**

### 待办(2026-06-27):完整复刻 + skill 切换门槛

**硬性决策:inbox_dispatcher skill 不切换到 curl POST /sync,直到 inbox-server 完整复刻 inbox_dispatcher 全功能并端到端验证对等。**(MVP 只通 telegram/dida + 知乎,切 skill 会静默丢内容)

**完整复刻清单(inbox-server 还差)**:
- **浏览器源**:inoreader / YouTube / Bilibili 3 个代登录源(架构同知乎 LoginStrategy + Scraper,各自 cookie/扫码策略)
- **Telegram 文件处理**:photo/document/video/audio 下载 → 入队 file → 坚果云(当前 TelegramSource 仅链接/文本)
- **Cubox 增强**:github URL 来源标签 + fishyer.com AI 摘要(当前 CuboxDestination 仅普通转存)
- **worker 智能标签集成**:process_link 现场调 `generate_smart_tags`(GLM)生成 3 标签(当前 worker.dispatch 未集成)
- **邮件通知**:汇总报告通道(agently-cli → QQ 邮箱,对等 inbox_sync.send_email_report)
- **scheduler/alembic**:✅ 已完成(APScheduler + 初始迁移)
- **docker-compose up 端到端**:进行中(验证 MVP server 可跑)

### browser-collect-worker：browser 源架构重构 + 启用知乎（feat/browser-collect-worker）

- 抽 `infrastructure/collectors/browser_collector.py` 共享模块（DRY），`orchestrator.run_collect` 瘦身只跑 API 源（server 无 DISPLAY 不再崩）
- `workers/runner.py` 加 `_browser_collect_loop`（每 60min，复用 worker 闲置 chromium+Xvfb，异常隔离 + graceful）
- `channels.yaml` 启用知乎（collection_id=1001447797，credential_name=zhihu_creds）；bilibili/inoreader/youtube 注释（缺凭据）
- 凭据/缓存复用：zhihu z_c0（zhihu-export2chrome）+ baseline 预填 1077 known（backup/zhihu.json）
- 端到端实测：worker browser collect 抓知乎收藏 20 条 → 13 skipped（known）+ 7 new（真正新增）入队 → GLM 标签 → cubox
