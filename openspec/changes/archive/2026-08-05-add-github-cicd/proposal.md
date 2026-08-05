## Why

inbox-server 已有本地 Docker Compose 部署和基础 CI，但缺少由 git-manager 管理的可追溯发布、SSH 自动部署与远端健康验收。需要让默认分支更新后自动创建 Release，并安全部署到固定的 testing 服务器。

## What Changes

- 使用 git-manager 生成受管 CI workflow，执行现有 ruff、非 E2E 测试和 mypy 门禁。
- 使用 git-manager 生成受管 Release/CD workflow，在 `main` 更新后创建确定性 GitHub Release 并通过 `testing` Environment 部署。
- 新增参数化部署入口，复用远端共享 `.env` 与 `channels.yaml`，以固定 Compose 项目名构建并启动服务。
- 为 testing 环境配置专用 SSH 身份、固定 known_hosts 和显式部署变量。
- 部署后验证 server、worker、Postgres、Redis、端口、重启策略和持久化卷。

## Capabilities

### New Capabilities

- `github-cicd`: 定义默认分支 CI、确定性 Release、SSH Docker Compose 部署、共享配置和远端健康验收行为。

### Modified Capabilities

无。

## Impact

- 新增 `git-manager.yml`、`entrypoint.sh`、git-manager 受管 GitHub Actions workflow 与部署入口测试。
- 新增 GitHub `testing` Environment、部署变量和 SSH secrets，并在测试服务器创建 `/apps/inbox-server` 发布结构。
- 不修改应用 API、业务代码、数据库 schema 或现有 `.github/workflows/ci.yml`。
