# inbox-server-desktop

在 Mac mini 上本地运行的收件匣。它复现 inbox-server 里用户真正每天用到的核心循环：收录、去重、限速入队、落到本机文件，并在一个只监听回环地址的界面里查看。

Cloudflare Workers、D1、Neon、Queues、Cloud Run、GCS、Browser Run、ima 和自建 FastAPI 都不参与。第三方内容服务（滴答、GitHub、Telegram，以及你自己填的 Cubox / flomo 地址）仍然可以直接调用，因为这些能力本身就不在你自己的服务器上。

这个目录是独立项目。把它整个拷走之后，不依赖仓库里的 `apps/` 或 `packages/`。

## 为什么是 Electron

桌面壳是 Electron，不是 Tauri，也不是单独开一个系统浏览器标签。

- 主进程就是原来的 Node 收件服务：SQLite、队列和定时同步都在这个进程里，没有 sidecar，也没有第二套 Rust 运行时。
- 界面跑在 Electron 窗口里，页面只能通过 `127.0.0.1` 访问本进程的 API。`nodeIntegration` 关闭，上下文隔离打开。
- 数据库用 Node 自带的 `node:sqlite`。Electron 45 带的 Node 已经包含这个模块，不需要为 Apple Silicon 再编译 better-sqlite3。
- 文章页先用普通 HTTP 取 HTML。正文太短或请求失败时，再用 Playwright 启动本机 Chromium 取渲染结果。登录态采集（知乎、B 站、Inoreader、YouTube、X）仍然没做。
- macOS arm64 安装包用 electron-builder 打未签名 zip。在 Linux 上也能打出这个 zip，因为不依赖 `hdiutil` 做 dmg。

Node 22 仍把 `node:sqlite` 标成实验接口。开发时直接用系统 Node 跑测试会看到这条警告，测试脚本把它关掉了。数据仍然只在本机 SQLite 文件里。

## 环境

- 开发：Node.js `>= 22.18 < 27`
- 运行打包后的应用：不需要另外装 Node。Electron 自带运行时
- 需要浏览器渲染的文章：再执行一次 `npx playwright install chromium`

```bash
cd inbox-server-desktop
npm install
npm test
npm run typecheck
npm start
```

`npm start` 和 `npm run dev` 都会先打包主进程，再打开 Electron 窗口。只想要没有窗口的本机服务时用 `npm run server`。API 只绑定回环地址，把 `INBOX_DESKTOP_HOST` 设成局域网地址会被拒绝。

| 变量 | 作用 |
| --- | --- |
| `INBOX_DESKTOP_HOME` | 数据目录。macOS 默认是 `~/Library/Application Support/inbox-server-desktop` |
| `INBOX_DESKTOP_PORT` | 内嵌服务端口，默认 `4731` |
| `INBOX_DESKTOP_OPEN` | 只对 `npm run server` 有效。设为 `0` 时不打开系统浏览器 |
| `INBOX_DESKTOP_PLAYWRIGHT_HEADLESS` | 设为 `0` 时 Playwright 使用有头 Chromium |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | 设为 `1` 时 `npm install` 不下载 Chromium |

数据库文件权限是 `0600`。链接、笔记、文件和文章分别在数据目录的 `library/` 与 `archive/sources/article/`。

## 架构

```text
Electron 窗口
  └─ http://127.0.0.1  ──►  同一个主进程
                              ├─ SQLite（条目、任务、额度、基线、同步记录）
                              ├─ 进程内调度器
                              ├─ HTTP 采集：滴答 / GitHub stars / Telegram
                              ├─ Playwright Chromium（仅当 HTTP 抽不出正文）
                              └─ 本地文件
                                   library/links|notes|files
                                   archive/sources/article
```

一条链接的路径：

1. 界面或采集器产生 `link` / `text` / `file` / `article`。
2. 用 SHA-256 做幂等键。整批先按云端队列的规则校验：单条不超过 128KB，再按 100 条或 256KB（含 100 字节预留）切开，然后一次写入 SQLite。
3. 调度器按上海时区套用现有额度：链接 500/日，文本 25 条/6 小时且 96/日，文件 1400 条/30 分钟，文章 60 条/小时且 10000/日。超限的任务延期，不扣额度。
4. 本地写入成功后才记 effect。链接在归档开关打开时再排一篇文章任务。
5. 文章先用 HTTP 取 HTML，不够再交给 Playwright。抽取仍然是简化的标题加正文，文件名沿用 `YYYYMMDD-标题.md`，UTF-8 不超过 171 字节。这不是 Defuddle，也不同步 ima 或 Git。

云端为了保护 Cubox，链接之间还有 5 秒间隔。本地文件不再插入这个间隔，额度数字保持一致。若配置了 Cubox 或 flomo，转发失败会留下本地副本并按 effect 重试，不会把同一条再写一遍。

滴答清单保持最新线上语义：先发布、再保存已见标题、然后逐条 DELETE。某一条返回非 404 失败就停，不回退已经记下的标题。GitHub stars 按 baseline 翻页，遇到没有新条目的一页就停。

## 从云端导入

Neon 里的任务正文放在加密信封中，桌面版没有那把密钥，不能把历史队列原样重放。能导入的是明文：归档事件、worker state、增量基线、同步记录，以及任务的状态历史。导出 SQL 故意不读取 `credentials`、`login_sessions` 和信封密文。

```bash
psql "$NEON_DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -f scripts/export-neon.sql -o cloud-export.json

INBOX_DESKTOP_HOME="$HOME/Library/Application Support/inbox-server-desktop" \
  npm run import -- ./cloud-export.json
```

导出格式是 `inbox-cloud-export-v1`。若某条任务自己带了明文 `payload`，并且状态还是 `queued` / `deferred` / `processing` / `failed`，导入时会重新入队。只有 `objectKey`、没有本机路径的旧 GCS 文件会被标成 `cloud_object_not_local`，不会去访问 GCS。

D1 如果还留着快照，需要先按仓库里的 `scripts/migrate_d1_snapshot.py` 进入 Neon，再跑上面的导出。不要把 D1 或 Neon 的连接串写进桌面版。

凭据要在本机界面重新填写。浏览器登录态没有导入，因为对应的采集器还没移植。

## 功能对照

| 能力 | 桌面版 |
| --- | --- |
| 手动收录链接、文本、文章、本机文件 | 有 |
| 去重、本地队列、限速、同步记录 | 有 |
| 滴答清单批量采集与逐条清理 | 有 |
| GitHub stars 增量 | 有 |
| Telegram 文本、链接和文件 | 有 |
| 本地 Markdown / 文件归档 | 有，替代坚果云、GCS、Git 仓 |
| Cubox、flomo | 可选转发。不填则只留在本机 |
| 云端明文历史导入 | 有 |
| 文章页在 HTTP 不够时用 Playwright 取 HTML | 有。需先 `npx playwright install chromium` |
| 知乎、B 站、稍后再看、Inoreader、YouTube、X | 未移植。登录态和分页还没接进采集器 |
| Defuddle 正文提取、知乎 API 正文 | 未移植，目前是简化 HTML 抽取 |
| ima 知识库、自动月份目录 | 未移植 |
| 智能标签 LLM | 未移植 |
| 邮件 / Telegram 通知 | 未移植 |
| Cloudflare Access、运维指标、告警、SLO | 不需要，本机没有这层控制面 |
| 密文 DLQ 重放 | 做不到，没有云端密钥 |
| Electron 窗口 | 有。`npm start` 打开窗口 |
| 签名的 dmg / 菜单栏常驻 | 未做。`npm run build:mac` 生成未签名的 macOS arm64 zip |

## 开发与打包

```bash
npm test            # node:test，不访问网络，也不启动 Electron
npm run typecheck
npm run build       # 类型检查，并把主进程打成 dist/main.js
npm start           # 开发时打开 Electron
npm run build:mac   # electron-builder，macOS arm64 zip
```

`npm run build:mac` 可以在 Apple Silicon 的 Mac 上执行，也可以在 Linux 上打出同一个 arm64 zip。产物在 `release/`，默认不签名。第一次在目标机器上打开需要右键打开，或对本机使用 `xattr -dr com.apple.quarantine`。装好应用后，若要让文章回退到浏览器渲染：

```bash
npx playwright install chromium
```

测试覆盖：批量上限与中文 UTF-8 分批、文件名长度、链接到本地归档、HTTP 不够时的 Playwright 回退、每日额度延期、滴答删除中断、GitHub 增量、本机文件、云端导入，以及 HTTP 收录后总览可读。
