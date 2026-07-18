## Context

文章归档任务运行在 Docker worker 中，当前由 `ArticleArchiveService` 生成 Markdown 后通过坚果云 WebDAV 上传。用户指定的权威文章目录已经改为宿主机 `~/.agents/references/article`，而 worker 既未挂载该仓库，也没有 GitHub SSH 身份，因此只有手工调用独立工具生成的一篇文章进入了 Git。

该变更必须保持 Cubox 分发与文章归档的独立重试边界，并避免提交 `.agents` 仓库中与本次文章无关的用户改动。

## Goals / Non-Goals

**Goals:**

- worker 自动把有效文章写入 `.agents/references/article`，提交并推送到现有远端。
- 以 frontmatter 的原始 `source_url` 精确去重；重试能够修复“已写入未提交”或“已提交未推送”的中间状态。
- Git 故障继续使用文章队列既有重试和 DLQ，不影响 Cubox 已完成状态。
- 只提交当前文章路径，保留 `.agents` 中其它暂存、未暂存和未跟踪内容。

**Non-Goals:**

- 不回迁坚果云已有历史文章。
- 不修改 Defuddle 源码或重新实现正文提取。
- 不为远端测试服务器自动创建 `.agents` 仓库或 GitHub 凭据。

## Decisions

### 1. 用 Git 归档适配器替换 WebDAV 适配器

应用服务依赖一个 `save_if_absent` 归档端口，Git 适配器负责同步、URL 去重、原子写文件、路径级提交和推送。相比在应用服务内拼接 Git 命令，这使业务编排保持可测试，并把文件系统与 Git IO 集中在基础设施层。

未采用“继续上传坚果云后再由其它进程同步”，因为它保留双写与最终一致性窗口，也无法满足每篇文章立即进入 Git 的要求。

### 2. worker 挂载宿主仓库并使用 HTTPS askpass

Compose 把 `${HOME}/.agents` 挂载到容器固定路径 `/article-repository`。Git 适配器把 GitHub SSH remote 映射为不含凭据的 HTTPS URL，通过固定 askpass 脚本从 worker 已有的 `GITHUB_TOKEN` 环境变量读取认证信息；Git 命令显式声明安全目录，避免容器 root 与宿主文件所有者不同导致拒绝操作。

未采用挂载宿主 `.ssh`，因为容器无法使用 macOS 钥匙串解锁带口令私钥，且会扩大容器可见凭据范围。token 不进入 remote URL、命令参数、文件或日志。

### 3. 原始 URL 是唯一幂等键

适配器扫描 `references/article/*.md` frontmatter 中的 `source_url` 做精确匹配。同 URL 已存在时仍检查并完成可能缺失的 commit/push；同日同标题但 URL 不同时，在文件名后追加稳定 URL 指纹，禁止覆盖已有文章。

### 4. 路径级提交并串行化进程内 Git 操作

适配器使用异步锁串行处理文章归档，并通过路径参数只提交目标 Markdown。已有 ahead 提交随 push 一并发布，符合 `.agents` 全局自动推送规则；其它工作区内容不进入本次提交。

## Risks / Trade-offs

- [宿主机 `.agents` 缺失或 `GITHUB_TOKEN` 没有仓库写权限会使归档失败] → 真实部署验证仓库挂载与 HTTPS push，失败进入文章重试而不影响 Cubox。
- [worker 与用户同时操作 `.agents` 可能发生 Git 锁或远端非快进] → Git 原生锁保护索引；每次写入前执行 `pull --ff-only`，失败时不覆盖或强推，由队列重试。
- [worker 环境中的 `GITHUB_TOKEN` 可写私有仓库] → 复用现有私有配置，只通过 askpass 读取，禁止写入 URL、命令行、仓库或日志。
- [GitHub 不可用会积压文章队列] → 沿用独立限速、重试和 DLQ，并保留本地已写入文件供下一次重试补交。

## Migration Plan

1. 部署代码和 Compose 挂载，保留现有坚果云历史文件不动。
2. 重建并重启 worker，确认仓库挂载、Git safe directory 和 HTTPS token 鉴权。
3. 投递一个未归档的真实文章 URL，验证 frontmatter、无效正文清理、本地提交和远端文件树。
4. 回滚时恢复 WebDAV 构建与旧配置后重建 worker；Git 已归档文章不删除。

## Open Questions

无。
