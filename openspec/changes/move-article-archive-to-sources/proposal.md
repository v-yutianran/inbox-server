# Proposal

## Why

个人知识库已按 obsidian-wiki 默认结构把不可变来源迁到 `.agents/sources/`。线上 Cloud Run Worker 仍写 `references/article/`，本地默认值又指向旧 Vault 目录，后续归档会偏离权威来源层。

## What Changes

- **BREAKING**：将文章归档唯一写入目录切到仓库根 `sources/article/`，保留正文、URL 去重、180 字节文件名与单文件 Git 交付行为。
- 更新两套运行时默认值、示例、本机配置和测试；在线上只更新 Cloud Run 挂载的渠道配置版本。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `article-markdown-archive`：文章 Git 归档目标从旧 Vault 路径改为 `sources/article/`。

## Impact

`apps/worker`、Python 兼容运行时、渠道配置、Secret Manager 渠道版本及 Cloud Run 修订版。`.agents` 仓库迁移和推送已单独完成。
