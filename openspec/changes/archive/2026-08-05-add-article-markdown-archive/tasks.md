## 1. 影响评估与测试基线

- [x] 1.1 刷新 GitNexus 索引，并对 `ItemKind`、`fingerprint`、`_make_process_link`、`run_worker`、目标构建器和坚果云 WebDAV 适配器执行 upstream impact analysis，记录 blast radius 与风险
- [x] 1.2 为文章队列类型、URL 预排除、正文验收、文件名清洗、frontmatter 规范化和 Markdown 渲染编写失败的领域单元测试
- [x] 1.3 为 Cubox 成功入队、Cubox 失败不入队、归档结果不重试 Cubox、归档重试/DLQ 和已存在跳过编写失败的 worker/基础设施测试

## 2. 领域模型与配置

- [x] 2.1 增加文章归档队列类型、URL 去重指纹和独立限速配置，并使既有 link/text/file 行为测试保持通过
- [x] 2.2 实现 URL 预排除和 Defuddle Markdown 正文验收纯函数，覆盖错误页标记、标题缺失、短正文和有效正文
- [x] 2.3 实现 Asia/Shanghai 归档日期、Unicode 规范化、空白/特殊字符移除、长度限制及空标题指纹兜底纯函数
- [x] 2.4 使用 Eta 模板实现 Obsidian frontmatter 与 Markdown 渲染，覆盖元数据转义、可选字段、智能标签数组和远程图片保留
- [x] 2.5 扩展 `channels.yaml` 与配置模型，增加默认关闭的文章归档开关、远端目录、正文阈值和超时，并补齐配置测试与 `.env.example` 说明

## 3. Defuddle 生产运行时

- [x] 3.1 增加 pnpm 管理的最小 Node.js 包配置和锁文件，固定 `defuddle@0.19.1` 及 Eta 版本，不引入全局 npm 依赖
- [x] 3.2 实现仓库内 ESM Defuddle 桥接器，以标准输入输出传递受限 JSON，并为标题、作者、发布时间、正文和异常协议增加固定 HTML 样本测试
- [x] 3.3 实现 Python 异步 Defuddle 子进程适配器，限制超时、输入/输出大小和日志内容，并覆盖成功、超时、异常退出及非法 JSON
- [x] 3.4 修改 Docker 构建以固定 Node.js 运行时、安装锁定生产依赖，并验证镜像内 Node.js、Defuddle 与 Python worker 均可启动

## 4. 抓取与坚果云归档

- [x] 4.1 实现直接 HTTP HTML 抓取适配器，设置 User-Agent、重定向、内容类型、响应大小和超时边界并补齐测试
- [x] 4.2 在现有 headed Playwright 浏览器运行时增加获取渲染后 HTML 的能力，完成 GitNexus 影响评估并覆盖导航成功、超时和资源释放测试
- [x] 4.3 实现“直接抓取与 Defuddle → 必要时 Playwright 与 Defuddle → 永久跳过或产出文章”的应用编排及分支测试
- [x] 4.4 抽取可复用的坚果云 WebDAV 存在检查和上传能力，保持既有 file 目标行为，并覆盖存在、上传成功、临时失败及凭据不泄露测试
- [x] 4.5 实现 `/我的坚果云/文章归档/<安全文件名>` 上传流程，确保非空 Markdown、目标存在跳过、临时文件清理和远端路径规范化

## 5. Cubox 后置入队与独立消费

- [x] 5.1 扩展 link 处理函数，在 Cubox `OK` 后携带最终标签提交归档任务，并为 Redis 入队增加有界重试和结构化失败日志
- [x] 5.2 注册单并发文章归档消费者，复用通用去重、限速、重试和 DLQ，并将非文章与文件存在映射为成功跳过
- [x] 5.3 更新队列状态和 DLQ 运维输出以包含文章归档队列，并补齐 API/仓库回归测试
- [x] 5.4 验证关闭文章归档时不启动新消费者、不创建归档任务，且 Cubox、flomo、file 和 browser collect 行为保持不变

## 6. 验证与交付

- [x] 6.1 使用本地普通文章、微信公众号错误页/完整页、视频页和同名文件样本完成非 E2E 集成验证；未获授权时不连接真实网页或坚果云执行自动化 E2E
- [x] 6.2 运行 `uv run ruff check src/inboxserver tests scripts`、非 E2E pytest、mypy，并构建 Compose worker 镜像验证 Node.js/Defuddle 运行时
- [x] 6.3 更新 `CHANGELOG.md`、运行 `openspec validate add-article-markdown-archive`，并用 GitNexus `detect_changes` 确认仅影响预期符号与流程

## 7. Frontmatter 回归修复

- [x] 7.1 增加真实 Eta 渲染回归测试，使用 YAML 解析器验证六个 Properties 独立成行、引号正确转义且结束分隔符合法，并先确认测试能复现失败
- [x] 7.2 禁用 Eta 自动换行裁剪，并增加支持 `--dry-run` 的历史 frontmatter 修复脚本；脚本必须先完整解析全部目标再写入，且保持正文逐字节不变
- [x] 7.3 备份并全量修复坚果云本地“文章归档”目录中的 70 个受影响文件，逐文件验证 YAML、字段、正文和本地/远端字节一致
- [x] 7.4 运行完整门禁、OpenSpec 校验和 GitNexus `detect_changes`，重建并重启 worker，验证新渲染结果后更新 `CHANGELOG.md`
