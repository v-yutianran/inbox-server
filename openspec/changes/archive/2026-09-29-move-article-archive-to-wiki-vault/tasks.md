# Tasks

## 1. 文件名约束

- [x] 1.1 RED：加入 TypeScript 与 Python 的中文长标题及碰撞后缀测试；`npm test -- --run tests/article-archive.test.ts -t '长中文标题'` 因 312>171 失败；`uv run pytest tests/unit/domain/test_article_archive.py tests/unit/infra/test_git_article_repository.py -k 'archive_filename_has_deterministic_fallback_and_length_limit or long_title_collision_stays_within_utf8_filename_limit' -q --tb=short` 因 336>171 和碰撞后超限失败
- [x] 1.2 GREEN：按完整字符截断并预留碰撞指纹空间；相同 TS 命令 1 passed，相同 Python 命令 2 passed
- [x] 1.3 REFACTOR：`rg` 核对直接调用者为 TS `createArticleArchiver`、Python `service` 与两套 Git 适配器；`npm test -- --run tests/article-archive.test.ts` 21 passed，`npm run typecheck` 通过，`uv run pytest tests/unit/domain/test_article_archive.py tests/unit/infra/test_git_article_repository.py -q --tb=short` 16 passed，`uv run mypy src/inboxserver/domain/policy/article_archive.py --ignore-missing-imports` 通过；未进行额外整理

## 2. 归档目录切换

- [x] 2.1 RED：默认配置测试改为 `.wiki-vault/raw/article`；`npm test -- --run tests/channels.test.ts -t '从环境变量插值'` 与 `uv run pytest tests/unit/test_article_archive_config.py -k defaults_to_disabled -q --tb=short` 均仅因仍返回 `raw/article` 失败
- [x] 2.2 GREEN：TypeScript、Python 默认值、示例及本机忽略配置已改；相同配置测试分别 1 passed、1 passed；本机配置与备份比较仅改一行且解析为 `.wiki-vault/raw/article`
- [x] 2.3 REFACTOR：`npm test -- --run tests/article-archive.test.ts tests/channels.test.ts` 23 passed；`uv run pytest tests/unit/domain/test_article_archive.py tests/unit/infra/test_git_article_repository.py tests/unit/test_article_archive_config.py tests/unit/workers/test_runner_article_archive.py -q --tb=short` 26 passed，覆盖显式目录、URL 去重与单文件提交；未新增适配层

## 3. 验证与记录

- [x] 3.1 `npm test && npm run typecheck && npm run build` 全部通过，Worker 160 passed；`uv run pytest tests/unit tests/integration -m 'not e2e' --tb=short -q` 318 passed、1 skipped、8 warnings；`uv run mypy src/inboxserver --ignore-missing-imports` 通过；Ruff 首轮指出新代码 `encode` 参数，修正后 `uv run ruff check src/inboxserver tests scripts` 通过，聚焦 Python 测试 16 passed；E2E 未获授权而跳过
- [x] 3.2 根 `CHANGELOG.md` 和 `docs/changelog/2026-09-29.md` 已记录 RED、GREEN、REFACTOR 命令与结果、全量门禁和未执行项
- [x] 3.3 `openspec validate move-article-archive-to-wiki-vault --strict` 与 `git diff --check` 通过；GitNexus upstream 对目标符号返回 UNKNOWN/lower-bound，`detect_changes` 因工作区既有大量改动整体报 critical，已按源码调用点与聚焦/全量测试核对本任务；提交只精确暂存本任务内容，不包含既有改动
