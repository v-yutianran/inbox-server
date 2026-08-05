## Why

worker 虽然能够生成文章 Markdown，但仍把文件上传到坚果云，导致用户指定的 `~/.agents/references/article` Git 知识库只有手工归档的一篇文章。需要把自动归档的唯一交付目标切换为该 Git 仓库，并让每次成功归档立即提交和推送。

## What Changes

- **BREAKING**：停止把文章 Markdown 上传到坚果云 `/我的坚果云/文章归档`，改为写入宿主机 `~/.agents/references/article`。
- worker 按原始 `source_url` 精确去重；同一 URL 已归档时不重复创建文件。
- 新文章写入后仅提交本次文章文件，并立即 push 到 `.agents` 仓库的远端分支。
- Git 同步、提交或推送失败时，文章归档任务保持失败并沿用现有重试和 DLQ 行为。
- worker 容器显式挂载宿主机 `.agents` 仓库，并通过现有 `GITHUB_TOKEN` 的 HTTPS askpass 鉴权，不依赖坚果云 WebDAV 或宿主 SSH 私钥。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `article-markdown-archive`：把归档交付契约从坚果云 WebDAV 改为本地 `.agents` Git 仓库的精确 URL 去重、提交和推送。

## Impact

- 代码：文章归档应用服务、Git 仓库适配器、worker 构建逻辑和渠道配置。
- 部署：worker Compose 挂载、宿主机 `.agents` 仓库及 `GITHUB_TOKEN` 仓库写权限。
- 测试：Git 适配器单元测试、文章归档服务测试、worker 构建测试与真实投递验证。
- 外部系统：文章 Markdown 不再写入坚果云；GitHub `.agents` 仓库成为唯一远端交付目标。
