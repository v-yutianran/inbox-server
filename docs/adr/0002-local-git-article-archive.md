---
status: accepted
---

# 使用本地 Git 仓库交付文章归档

文章 Markdown 的权威交付位置已经从坚果云改为用户的 `~/.agents/references/article`，但 worker 运行在容器内，原有 WebDAV 上传无法触达该 Git 工作流。决定由 worker 挂载宿主 `.agents` 仓库，通过专用适配器按原始 URL 去重、仅提交当前文章，并使用现有 `GITHUB_TOKEN` 的 HTTPS askpass 立即推送；相比继续双写坚果云、挂载无法解锁的宿主 SSH 私钥或增加同步守护进程，该方案只有一个事实来源，并沿用文章队列现有失败重试边界。

具体需求与迁移步骤见 [move-article-archive-to-git OpenSpec 变更](../../openspec/changes/move-article-archive-to-git/proposal.md)。
