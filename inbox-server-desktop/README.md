# inbox-server-desktop

在 Mac mini 上本地运行的收件匣。它复现 inbox-server 里用户真正每天用到的核心循环：收录、去重、限速入队、落到本机文件，并在一个只监听回环地址的界面里查看。

Cloudflare Workers、D1、Neon、Queues、Cloud Run、GCS 和自建 FastAPI 都不参与。第三方内容服务仍然可以直接调用，因为这些能力本身就不在你自己的服务器上：滴答、GitHub、Telegram、知乎、哔哩哔哩、Inoreader、YouTube、X、Cubox、flomo、坚果云、ima.qq.com、智谱 GLM，以及你填写的 SMTP。密钥只写在本机设置界面，或数据目录里的 `settings.json`，不会写进代码。空字符串表示保留原密钥，`null` 表示清除。样例见 `settings.example.json`。

这个目录是独立项目。把它整个拷走之后，不依赖仓库里的 `apps/` 或 `packages/`。

## 为什么是 Electron

桌面壳是 Electron，不是 Tauri，也不是单独开一个系统浏览器标签。

- 主进程就是原来的 Node 收件服务：SQLite、队列和定时同步都在这个进程里，没有 sidecar，也没有第二套 Rust 运行时。
- 界面跑在 Electron 窗口里，页面只能通过 `127.0.0.1` 访问本进程的 API。`nodeIntegration` 关闭，上下文隔离打开。
- 数据库用 Node 自带的 `node:sqlite`。Electron 45 带的 Node 已经包含这个模块，不需要为 Apple Silicon 再编译 better-sqlite3。
- 文章页先用普通 HTTP 取 HTML，知乎链接在已登录时改走知乎 API。正文用 Defuddle 提取，失败时退回标签剥离。HTTP 正文太短时，再用 Playwright 启动本机 Chromium。
- 登录态来源在 Electron 里打开独立窗口。关掉窗口后，cookie 写入本机 `profiles/<平台>.json`，采集时交给 Playwright。也可以粘贴 `z_c0`、`SESSDATA` 或 storageState。
- macOS arm64 安装包用 electron-builder 打未签名 zip，并尝试未签名 dmg。签名需要你自己的 Apple 证书，这个仓库里没有。

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
                              ├─ 登录态采集：知乎 / 哔哩哔哩 / 稍后再看 / Inoreader / YouTube / X
                              ├─ Playwright Chromium（登录态，以及 HTTP 抽不出正文时）
                              ├─ 转发：Cubox / flomo / 坚果云 WebDAV
                              ├─ 文章：Defuddle、本机 Git、ima
                              ├─ 通知：Telegram、SMTP 465
                              └─ 本地文件
                                   library/links|notes|files
                                   archive/sources/article
                                   profiles/<平台>.json
                                   settings.json
```

一条链接的路径：

1. 界面或采集器产生 `link` / `text` / `file` / `article`。
2. 用 SHA-256 做幂等键。整批先按云端队列的规则校验：单条不超过 128KB，再按 100 条或 256KB（含 100 字节预留）切开，然后一次写入 SQLite。
3. 调度器按上海时区套用现有额度：链接 500/日，文本 25 条/6 小时且 96/日，文件 1400 条/30 分钟，文章 60 条/小时且 10000/日。超限的任务延期，不扣额度。
4. 本地写入成功后才记 effect。链接在归档开关打开时再排一篇文章任务。
5. 文章先用 HTTP 取 HTML，知乎已登录时改走对应 API。Defuddle 提取正文，失败则剥离标签。不够再交给 Playwright。文件名沿用 `YYYYMMDD-标题.md`，UTF-8 不超过 171 字节。归档开关打开时，文章再提交到数据目录里的本地 Git 仓库，不配置远程。ima 打开后按月份目录镜像；重复指纹会跳过。
6. 文本在配置了智谱 key 且没有标签时，请求 glm-4-flash 生成最多 3 个标签。失败就当没有标签，不挡住收录。
7. 采集有新条目时发通知。Telegram 和邮件失败只记在同步统计里，不回滚已经入队的内容。

云端为了保护 Cubox，链接之间还有 5 秒间隔。本地文件不再插入这个间隔，额度数字保持一致。Cubox、flomo、坚果云各自记 effect。某一路失败会留下本地副本并只重试没完成的那一路。

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

凭据和浏览器登录态要在本机界面重新填写。云端导出不包含 cookie。

## 功能对照

| 能力 | 状态 | 如何验证 |
| --- | --- | --- |
| 手动收录链接、文本、文章、本机文件 | 完成 | `tests/core-flow.test.ts`、`tests/parity.test.ts` |
| 去重、本地队列、限速、定时同步 | 完成 | 核心流测试。调度器按设置间隔调用同一条 `sync` |
| 滴答清单批量采集与逐条清理 | 完成 | 核心流：删除在 id 2 失败时停止，第二次同步补删且不重复入队 |
| GitHub stars 增量 | 完成 | 核心流：第二页为空，重复同步仍只有 1 条 |
| Telegram 收集文本、链接和文件 | 完成 | 采集器沿用云端解析；通知发送另有模拟测试 |
| 知乎收藏、B 站收藏、稍后再看、Inoreader、YouTube 稍后观看、X 书签 / 喜欢 | 完成（采集逻辑） | 假页面测试覆盖分页、星标 key、播放列表和推文。真实账号登录需在本机窗口做一次，此环境没有这些账号 |
| 应用内登录窗口，cookie 存在本机 | 完成 | Electron `BrowserWindow` 分区 `persist:inbox-<平台>`，关闭后写入 `profiles/*.json`。单测把 `z_c0`、`SESSDATA` 和 Electron cookie 转成 storageState。无窗口的 `npm run server` 会提示改用 Electron 或粘贴 cookie |
| 本地 Markdown / 文件归档 | 完成 | 核心流检查链接、文章和本机文件路径 |
| 本机 Git 归档，不推远程 | 完成 | 文章任务后 `git log` 能看到提交；测试仓库用户是 `inbox@localhost` |
| Defuddle 正文，失败回退；知乎 API 正文 | 完成 | 样例 HTML 与 `https://example.com/` 真请求都能抽出标题。知乎回答在假 cookie 下走 API，正文写入归档 |
| ima 知识库、月份目录、COS 上传 | 完成（协议） | 模拟 OpenAPI：查库、查月份目录、查重、创建媒体、PUT 到 `*.myqcloud.com`、写入知识。真实调用要在设置里填 key，仓库不内置密钥 |
| Cubox、flomo | 完成（协议） | 核心流断言 Cubox POST。flomo 在标签流水线测试里返回 `code: 0` |
| 坚果云 WebDAV | 完成（协议） | 模拟 PUT，并在引擎里确认文件任务打到配置的 base URL |
| 智谱智能标签 | 完成（协议） | 模拟 chat completions，笔记文件带上返回的标签。失败返回空数组 |
| Telegram 通知、163 SMTP 通知 | 完成（协议） | 模拟 `sendMessage`。本机自签 TLS 走 AUTH LOGIN 和 DATA。真实 bot / 授权码由用户填写 |
| 云端明文历史导入 | 完成 | 核心流：密文信封只计数，明文延期任务重新入队 |
| HTTP 不够时 Playwright 取 HTML | 完成 | 核心流注入短 HTML 后改用回退。另有真 Chromium 打开 `https://example.com/` |
| 设置界面与 `settings.json` | 完成 | 界面包含各来源、转发、通知、ima、模型。公开接口只返回是否已设置。文件模式 `0600` |
| Cloudflare Access、运维指标、告警、SLO | 不做 | 本机没有这层控制面 |
| 密文队列重放 | 做不到 | 没有云端信封密钥。导出只计数 |
| Electron 窗口 | 完成 | `npm start` 打开窗口，外链走系统浏览器 |
| 未签名 macOS arm64 zip / dmg | 见打包一节 | `npm run build:mac`。签名 dmg 需要 Apple 证书，当前环境没有 |
| 菜单栏常驻 | 不做 | 云端也没有对应的桌面常驻进程。窗口关闭即退出 |

真实登录知乎、哔哩哔哩、Inoreader、YouTube 和 X，以及真实调用 Cubox、flomo、坚果云、ima、智谱、Telegram 和 SMTP，都停在用户自己的账号和密钥上。代码路径和协议用假服务验证过，仓库里不放任何密钥。

## 开发与打包

```bash
npm test            # 含 example.com 真请求；Playwright 用例需要已安装的 Chromium
npm run typecheck
npm run build       # 类型检查，并把主进程打成 dist/main.js
npm start           # 开发时打开 Electron
npm run build:mac   # electron-builder，macOS arm64 未签名 dmg 和 zip
```

文章 HTTP 回退默认无头。登录态采集默认有头，以便对付会拦截无头浏览器的站点；设 `INBOX_DESKTOP_PLAYWRIGHT_HEADLESS=1` 可改成无头。登录窗口始终是 Electron 有头窗口。

`npm run build:mac` 在 Apple Silicon 的 Mac 上会同时产出未签名 dmg 和 zip。产物在 `release/`。第一次打开需要右键打开，或对本机使用 `xattr -dr com.apple.quarantine`。没有 Apple 证书，所以不会签名。浏览器二进制不进安装包：

```bash
npx playwright install chromium
```

这次在 Linux 上已经打出 `release/Inbox Desktop-0.1.0-arm64-mac.zip`（约 339MB）。包内 `Inbox Desktop.app/Contents/MacOS/Inbox Desktop` 是 Mach-O arm64。同一条命令接着做 dmg 时失败，原因是 electron-builder 下载的 `dmgbuild` 自带 Python 是 macOS 二进制：

```text
python3.14: Mach-O 64-bit x86_64 executable
cannot execute binary file: Exec format error
```

使用默认底图时还会先缺 macOS 的 `sips`（`spawn sips ENOENT`）。这台 Linux 环境没有 `hdiutil`，也不能执行这个 Mach-O 工具，所以未签名 dmg 要在 macOS 上跑同一条 `npm run build:mac` 才能生成。配置里已经包含 dmg 目标。
