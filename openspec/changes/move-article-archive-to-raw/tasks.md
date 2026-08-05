## 1. 路径契约实现

- [x] 1.1 RED：将 TypeScript 与 Python 默认配置、Git 写入路径测试改为 `raw/article`，确认旧实现按预期失败
- [x] 1.2 GREEN：把 TypeScript Worker、Python 兼容运行时和 `channels.yaml.example` 默认路径切换为 `raw/article`
- [x] 1.3 REFACTOR：保持显式 `articles_dir`、URL 去重、单文件提交和 push 流程不变，并确认无新增兼容层或依赖

## 2. 事实源与说明

- [x] 2.1 更新 canonical `article-markdown-archive` spec 与文章归档 ADR 的当前路径说明，不改写历史 archive
- [x] 2.2 在 `CHANGELOG.md` 记录路径切换、非目标和真实验证命令

## 3. 验证与交付

- [x] 3.1 运行聚焦测试、Workspace test/typecheck/build、Python ruff/pytest/mypy、OpenSpec strict 与 `git diff --check`
- [x] 3.2 运行 GitNexus `detect_changes`，按 git-manager 精确提交、push 并创建 PR，不部署、不合并
