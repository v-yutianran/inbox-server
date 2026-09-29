# Design

## Context

见 [proposal.md](proposal.md)。Cloud Run 当前 100% 流量使用固定镜像 digest，`CHANNELS_PATH` 指向 Secret Manager 挂载的 `channels.yaml`，版本 1 实际配置为 `references/article`。`.agents` 远端 `main` 已有 `sources/article/`。

## Goals / Non-Goals

**Goals:** 统一未来构建的默认路径与线上实际路径；让已迁移的来源继续按 `source_url` 去重。

**Non-Goals:** 不重建或更换 Worker 镜像，不重放任务，不改变正文、队列或 Git 交付实现。

## Decisions

1. 仍使用现有相对 `articles_dir`，只换成 `sources/article`；现有仓库适配器和 Git 提交流程无需修改。
2. 本地只改默认值、示例和测试。线上从渠道 Secret 版本 1 复制完整配置，只替换目标路径并发布新版本，Cloud Run 新修订版继续使用原镜像 digest。
3. 发布前确认 `.agents` 远端完成迁移；发布后检查修订版 Ready、挂载版本和新归档提交路径。回退时把服务挂载改回旧 Secret 版本，并先对账两目录新增文章。

## Risks / Trade-offs

- Secret 中其它配置变化 → 以版本 1 为输入做单行替换、校验内容摘要并保留原版本。
- 部署切换时仍有旧 Worker 在途归档 → 切流前后对账远端两个目录，不删除任何新增正文。
- `inbox-server` 工作区存在并行改动 → 精确暂存路径与块，部署沿用现有镜像。
