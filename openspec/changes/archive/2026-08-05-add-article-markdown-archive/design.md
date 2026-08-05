## Context

当前 worker 并发消费 `link`、`text`、`file` 三类 Redis 队列。`link` 消费者生成智能标签后调用 Cubox，成功即写入去重状态；坚果云适配器只处理已经存在于本地的文件。worker 镜像已经具备 Python Playwright、Chromium 和 Xvfb，但没有受项目依赖锁管理的 Defuddle 运行时。

本变更跨越链接分发、独立队列、网页抓取、Node.js 子进程、Markdown 生成和 WebDAV 上传。核心约束是：Cubox 成功与文章归档必须形成两个独立结果，任何归档故障都不得触发 Cubox 再次分发。

## Goals / Non-Goals

**Goals:**

- 在 Cubox 成功后，为上线后的文章型链接创建可独立重试、去重和进入死信队列的归档任务。
- 将固定版本 Defuddle 作为 inbox-server 的生产依赖集成到现有 worker 镜像。
- 复用 Python headed Playwright 作为直接抓取和首次 Defuddle 解析不足时的兜底。
- 生成带 Obsidian Properties 的安全 Markdown 文件，并上传到坚果云固定目录。
- 保持文章识别、正文验收、文件名清洗和 Markdown 渲染为可单测的纯函数。

**Non-Goals:**

- 不回填 Cubox 或现有队列中的历史链接。
- 不归档视频页、代码仓库页、下载文件或经两次解析仍不满足正文标准的网页。
- 不下载、改写或内嵌正文图片，不处理网页附件。
- 不新增对外 API，不改变 text、file 队列的分发语义。
- 不承诺 Cubox 外部调用与 Redis 归档入队之间的跨系统原子性。

## Decisions

### 1. 使用独立的文章归档队列

在 `ItemKind` 中增加文章归档类型，并沿用现有 Redis 队列、成功去重、限速、重试和 DLQ 机制。归档载荷只包含后续处理所需的 `url`、`title`、Cubox 智能标签和归档请求时间，不复制网页 HTML。

链接处理函数仅在 Cubox 返回 `DispatchOutcome.OK` 后入队。归档消费者的成功、跳过、失败和最终 DLQ 均不修改已经完成的 Cubox 结果。选择独立队列而不是在 link 消费函数中同步归档，是为了避免慢网页或 WebDAV 故障占用 Cubox 限速窗口，并杜绝归档重试引发 Cubox 重复分发。

Cubox 成功到 Redis 入队无法构成分布式事务。入队使用小次数、短退避的有界重试；仍失败时输出带 URL 指纹的结构化错误并进入现有通知路径，但 link 消费仍返回成功。相比引入数据库 outbox，本方案保持当前架构简单；残余丢失窗口在风险章节显式记录。

### 2. 采用“预排除 + 内容验收”识别文章

纯函数预排除非 HTTP(S)、已知视频/代码仓库域名以及常见下载扩展名。其余链接先由共享 `httpx.AsyncClient` 获取 HTML，再通过 Defuddle 解析；只有标题存在且去除 frontmatter、链接和空白后的正文达到最小有效长度，才判定为文章。

直接抓取失败、命中错误页标记或正文不足时，归档消费者调用现有 headed Playwright 获取渲染后 HTML，并再次交给同一 Defuddle 解析器。第二次仍不满足文章标准属于永久性“非文章”结果，记录原因后按成功跳过，不进入重试或 DLQ。

### 3. 通过受约束的 Node.js 桥接器调用 Defuddle

仓库增加最小 ESM 桥接脚本和 pnpm 锁文件，固定使用已经过 `weixin-article` 验证的 `defuddle@0.19.1`。Docker 构建阶段安装锁定的生产依赖，并验证 `node` 和 Defuddle 可执行；运行时不依赖宿主机全局 skill 或全局 npm 包。

Python 使用 `asyncio.create_subprocess_exec` 启动桥接器，以 JSON 经标准输入传入 URL 和 HTML，经标准输出接收标题、作者、发布时间、正文 Markdown 等结构化结果。调用设置超时、HTML 大小上限和输出大小上限，标准错误只记录脱敏摘要，禁止把 HTML 或 WebDAV 凭据写入日志。选择子进程边界是因为 Defuddle 原生属于 Node.js 生态，同时避免在 Python 中复制解析规则。

### 4. 将领域规则与 IO 适配器分离

文章归档由以下边界组成：

- 领域纯函数：URL 预排除、Defuddle 结果验收、Obsidian 文件名清洗、frontmatter 数据规范化和 Markdown 渲染。
- IO 适配器：直接 HTML 抓取、headed Playwright HTML 抓取、Defuddle 子进程和坚果云 WebDAV。
- 应用编排：按“直接抓取 → Defuddle → 必要时 Playwright → Defuddle → 渲染 → 存在检查 → 上传”顺序协调上述能力，并将结果映射为 `OK` 或 `FAIL`。

坚果云上传复用现有 WebDAV 凭据和远端根目录规则；共享的 WebDAV 操作下沉为可复用适配器，避免文章归档复制认证和上传逻辑。

### 5. 生成确定性的 Obsidian Markdown

远端目录固定为 `/我的坚果云/文章归档`。文件名使用 Asia/Shanghai 的归档日期和 Defuddle 标题，格式为 `YYYYMMDD-文章标题.md`；标题经过 Unicode 规范化，移除全部空白和 Obsidian/常见文件系统特殊字符，并限制长度。清洗后为空时使用 URL 主机名与稳定短指纹兜底。

frontmatter 使用稳定字段 `title`、`source_url`、`archived_at`、`author`、`published_at`、`tags`；缺失的可选元数据保留为空值，标签沿用 link 消费阶段提交给 Cubox 的智能标签。正文图片保持 Defuddle 生成的远程 URL。上传前通过 WebDAV 检查完整目标路径，文件已存在时记录 `article_archive_exists` 并按成功跳过。

### 6. 配置和运行边界沿用现有项目惯例

`channels.yaml` 继续作为启用状态、远端目录和归档参数的单一配置源；`.env` 继续只保存坚果云凭据，不新增明文秘密。文章归档消费者单并发运行，并使用独立限速键，避免 Playwright 兜底与已有浏览器采集争抢过多资源。关闭文章归档配置后不启动该消费者，Cubox 行为保持原样。

## Risks / Trade-offs

- [Cubox 成功与归档入队不是原子事务，极端崩溃可能漏归档] → 入队执行有界重试、记录稳定 URL 指纹并触发现有错误通知；不以重试 Cubox 换取理论上的强一致性。
- [Node.js 与 Defuddle 增大镜像和供应链范围] → 固定 Defuddle 版本、提交 pnpm 锁文件、仅安装生产依赖，并在镜像验证中检查版本。
- [动态网页可能增加 Chromium 内存和耗时] → 仅在直接解析失败时使用 headed Playwright，归档消费者单并发且设置导航与解析超时。
- [正文长度启发式可能误判短文或导航页] → 保留结构化跳过原因，并把阈值集中在领域策略中以便用真实样本调整。
- [远程图片可能失效] → 当前范围接受该风险；若未来要求完全离线，再单独设计资源下载和引用改写能力。
- [同日同标题但不同 URL 会命中相同文件名] → 按用户约定将目标存在视为成功跳过，不覆盖已有文件。

## Migration Plan

1. 先合入配置模型、队列类型、纯函数与测试，默认关闭文章归档。
2. 集成 Node.js/Defuddle 桥接器、Docker 构建验证、抓取编排和 WebDAV 上传。
3. 在测试配置中启用功能，用本地 HTML 样本和替身验证普通文章、公众号 Playwright 兜底、非文章跳过、文件存在跳过和失败重试/DLQ；只有获得当前任务的自动化 E2E 授权后，才连接真实网页与坚果云执行端到端验证。
4. 部署 worker 后再启用生产 `channels.yaml` 配置；仅新发生的 Cubox 成功事件会创建归档任务。
5. 回滚时关闭文章归档配置并重建 worker；保留已生成 Markdown 和归档 DLQ，不影响 Cubox、text、file 队列。

## Open Questions

无。正文长度、超时和归档限速采用实现任务中固定并由测试覆盖的保守默认值，不作为用户可见契约。
