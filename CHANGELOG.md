# CHANGELOG

## 2026-06-28

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
