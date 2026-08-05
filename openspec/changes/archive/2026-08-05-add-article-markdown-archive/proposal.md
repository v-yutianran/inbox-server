## Why

当前链接分发在成功保存到 Cubox 后即结束，原文内容没有进入用户的 Obsidian/坚果云知识库；当网页失效、下架或后续无法访问时，已收藏链接无法提供可检索的正文。需要在不影响 Cubox 分发可靠性的前提下，为文章型网页增加独立、可重试的 Markdown 归档能力。

## What Changes

- 链接成功保存到 Cubox 后，创建独立的文章归档任务；归档失败不得导致 Cubox 重复分发。
- 在现有 worker 镜像中集成固定版本的 Node.js 与 Defuddle，由归档消费者提取文章正文并生成 Markdown。
- 先排除已知非文章链接，再按 Defuddle 提取结果识别文章；普通抓取内容不足时，使用现有 headed Playwright 获取完整 HTML 后重新解析。
- 将 Markdown 上传到坚果云 `/我的坚果云/文章归档`，采用 Obsidian 安全文件名，目标文件已存在时跳过。
- Markdown 写入标题、原文链接、归档时间、作者、发布时间和 Cubox 智能标签；图片保留原网页链接。
- 归档任务使用独立重试与死信处理；非文章链接视为正常跳过，仅处理功能上线后的新链接。

## Capabilities

### New Capabilities

- `article-markdown-archive`: 定义文章识别、Defuddle/Playwright 抓取、Obsidian Markdown 生成、坚果云上传、去重和独立失败处理。

### Modified Capabilities

- `dispatch-tagging`: 链接完成智能标签生成并成功分发到 Cubox 后，必须提交独立文章归档任务，同时保持 Cubox 成功状态不受后续归档结果影响。

## Impact

- 影响链接 worker 编排、Redis 队列与死信处理、浏览器运行时、坚果云 WebDAV 适配器和渠道配置。
- worker 镜像新增固定版本 Node.js 与 Defuddle 生产依赖，并增加 Python 到 Defuddle 子进程的调用边界。
- 新增文章识别、Markdown 渲染、文件名清洗和归档消费者测试；现有 Cubox、文本及文件分发行为保持兼容。
- 不新增或修改对外 API，不回填历史链接，不下载正文图片。
