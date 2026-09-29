# Proposal

## Why

个人知识库已迁入 `.agents/.wiki-vault/`，但文章归档的配置、默认值和现行部署路径仍可能写入旧目录。中文长标题生成的文件名还会使 Android Gitling pull 失败。

## What Changes

- **BREAKING**：将文章归档默认目录改为 `.wiki-vault/raw/article`，保留按 `source_url` 幂等去重和单文件 Git 交付。
- 将文件名上限设为含扩展名 180 个 UTF-8 字节；碰撞指纹追加后仍须符合上限。
- 更新本地示例与现行配置路径；远程 worker 部署另行授权。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `article-markdown-archive`：修改文章归档路径与文件名约束。

## Impact

TypeScript Worker、Python 兼容运行时、`channels.yaml` 配置、文章归档测试与 `.agents` Git 仓库。此前完成但未归档的 `move-article-archive-to-raw` change 记录旧阶段，本文定义迁至新 Vault 的后续阶段。
