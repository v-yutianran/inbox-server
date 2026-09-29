# Design

## Context

TypeScript Worker 是当前生产归档实现，Python 路径是兼容运行时。两者从仓库根目录解析相对 `articles_dir`，并在该目录按 `source_url` 去重；当前本机忽略配置实际仍指向 `references/article`。目标资料已复制到 `.agents/.wiki-vault/raw/article`，包括远端现有归档。

## Goals / Non-Goals

**Goals:** 统一两套运行时的默认目录、示例和本机配置；保证正常文件名与碰撞文件名均在 180 个 UTF-8 字节内；保留现有 URL 去重与交付流程。

**Non-Goals:** 本 change 不部署 worker，不修改已有文章正文，不改变 Git 同步、队列、抓取或遥测语义。

## Decisions

1. 继续使用相对目录配置，默认值改为 `.wiki-vault/raw/article`。仓库根目录与 Git 提交边界不变；无需新增路径适配层。
2. 以 UTF-8 字节而非字符数计量文件名，给已有的 `-<8 位 URL 指纹>` 预留 9 字节，再按完整 Unicode 字符截断标题。180 字节低于常见单组件 255 字节上限，并避免中文按字符数截断后实际过长。
3. 现有 `source_url` 扫描仍只查目标目录。迁移先放入既有文章，再切运行配置；这样旧 URL 不会因路径切换而重复归档。

## Risks / Trade-offs

- 远端 worker 在新版本部署前继续写旧目录 → 部署前核对远端新文章并补入 Vault，部署后确认实际 `articles_dir` 与新提交路径。
- 标题截断会提高同名概率 → 复用现有 URL 指纹碰撞处理，并为后缀预留字节。
- 当前 checkout 有其它未提交工作 → 只编辑本 change 的文件和相应行，不整文件覆盖或混入其它暂存内容。

## Migration Plan

本地验证路径、去重和长度门禁；待 `.agents` 迁移提交已集成远端后，再按单独授权推送与部署 worker。回滚仅恢复运行时目录配置；新目录中的文章保留，回滚前需检查两目录间的新写入差异。
