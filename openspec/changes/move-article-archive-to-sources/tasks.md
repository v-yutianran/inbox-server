# Tasks

## 1. 路径契约

- [x] 1.1 RED：`npm test -- --run tests/channels.test.ts -t '从环境变量插值'` 1 failed，收到旧默认路径；`uv run pytest tests/unit/test_article_archive_config.py tests/unit/infra/test_git_article_repository.py -k 'defaults_to_disabled or saves_commits_and_pushes_new_article' -q --tb=short` 2 failed，仅因默认目录仍旧。
- [x] 1.2 GREEN：两套默认值、示例和已校验备份的本机配置改为 `sources/article`；上述相同命令分别 1 passed、2 passed，本机配置核对仅改路径一行；180 字节逻辑未改。
- [x] 1.3 REFACTOR：无额外整理；`npm test -- --run tests/channels.test.ts tests/article-archive.test.ts` 23 passed，Python 相关 19 passed；`npm test`、`npm run typecheck`、`npm run build`、Ruff、mypy 均通过，Python 全量 318 passed/1 skipped/8 warnings。

## 2. 线上切换

- [x] 2.1 从线上渠道 Secret 版本 1 仅替换 `articles_dir` 生成版本 2，逐字节读回验证；版本 1 保留，`.agents` 远端为迁移提交 `3c0b5e73`。
- [x] 2.2 Cloud Run 原镜像 digest 的新修订版 `inbox-server-worker-wiki-sources-0929` Ready，挂载版本 2、`/readyz` 200 且承接 100% 流量；远端旧目录 0 篇、新目录 6,779 篇。真实新文章写入待自然任务观察。
- [ ] 2.3 更新当日 Changelog、运行 `openspec validate` 与 GitNexus `detect_changes`，精确提交并推送本仓库变更。
