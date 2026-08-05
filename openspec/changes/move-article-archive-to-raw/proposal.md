## Why

文章归档当前写入 `.agents/references/article`，与用户要求的原始材料分区不一致。将唯一自动归档目标调整为 `.agents/raw/article`，使新文章进入明确的 raw 层并避免继续扩大旧目录。

## What Changes

- **BREAKING**：新归档文章的默认写入路径从 `references/article` 改为 `raw/article`。
- 同步 TypeScript Worker、Python 兼容运行时、示例配置和当前文档事实源的路径契约。
- 保留按 `source_url` 去重、单文件提交和立即推送语义；本 change 不迁移或删除历史 `references/article` 文件，也不部署线上服务。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `article-markdown-archive`：将 Git 文章归档的权威新写入目录改为 `raw/article`。

## Impact

- 代码：`apps/worker` 的渠道默认配置、Python `ArticleArchiveConfig` 与 `GitArticleRepository` 默认值。
- 测试与配置：TypeScript/Python 归档契约测试、`channels.yaml.example`。
- 文档：canonical OpenSpec、文章归档 ADR 与 Changelog。
- 不新增 API、生产依赖或数据迁移；历史归档文件保持原位。
