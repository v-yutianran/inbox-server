## Context

文章归档由 TypeScript Worker 作为当前生产实现、Python 代码作为兼容运行时，共享 `article_archive.articles_dir` 契约。两套默认值、Git 适配器和测试目前都指向 `references/article`；`.agents` 仓库挂载、按 URL 去重、单文件提交与 push 流程无需改变。

## Goals / Non-Goals

**Goals:**

- 让未显式配置 `articles_dir` 的新归档统一写入 `.agents/raw/article`。
- 让 TypeScript、Python、示例配置、canonical spec 和当前 ADR 对新路径保持一致。
- 保持现有原子写入、URL 去重、冲突文件名、重试、提交和推送语义。

**Non-Goals:**

- 不移动、复制或删除 `references/article` 中的历史文件。
- 不增加旧目录 fallback 扫描、双写或数据迁移兼容层。
- 不修改线上配置、部署或触发真实文章归档。

## Decisions

1. 将 `raw/article` 作为唯一默认新写入目录，同时保留 `articles_dir` 显式配置能力。相比硬编码绝对路径，这继续让 Worker 以已挂载的 `.agents` 仓库根目录解析相对路径。
2. TypeScript 与 Python 默认值同步切换，避免当前生产实现和兼容运行时产生不同归档位置。相比只改线上 TypeScript，统一契约更容易测试和回滚。
3. 不读取旧目录。相比新增双目录查重兼容层，本 change 保持用户要求的最小路径切换，并避免长期维护两个事实源；历史数据迁移需独立授权。
4. 历史 OpenSpec archive 与旧 Changelog 保持不变；canonical spec 改由本 delta 更新，ADR 追加后续决定说明而不改写当时背景。

## Risks / Trade-offs

- [历史 URL 在旧目录中但被重新投递时，新目录扫描无法识别] → 本 change 不重放历史任务；若需要跨目录去重或迁移，另行设计并授权。
- [部署环境仍显式配置旧路径时不会自动切换] → 示例与默认值改为新路径，实际部署变更留给独立部署任务验证。
- [两个运行时默认值漂移] → TypeScript 与 Python 都增加默认路径契约测试。

## Migration Plan

1. 合并代码后，新部署在未覆盖 `articles_dir` 时使用 `raw/article`。
2. 若需要线上切换，部署任务先只读确认实际配置，再更新精确配置并验证一篇隔离 canary；本 change 不执行该步骤。
3. 回滚仅恢复默认配置与部署配置到 `references/article`；已经写入 `raw/article` 的文件不得自动移动或删除。

## Open Questions

无。
