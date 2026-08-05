## Context

inbox-server 已有面向 `main` 的基础 CI 和可在本机运行的 Docker Compose，但发布、远端配置、版本切换与部署验收仍依赖人工操作。目标服务器是固定的 testing 主机，应用包含 server、worker、Postgres 和 Redis；`.env` 与 `channels.yaml` 含运行配置，不能进入 Git 或 Release 归档。部署还必须保持 Compose 命名卷连续，避免切换发布目录时创建全新的数据库卷。

## Goals / Non-Goals

**Goals:**

- `main` 更新且质量门禁通过后，创建可追溯的确定性 GitHub Release，并自动部署到 testing Environment。
- 使用专用 SSH 身份和固定主机密钥，通过 `/apps/inbox-server/releases/<tag>` 与 `current` 软链接支持原子切换。
- 从 `/apps/inbox-server/shared` 复用未入库的 `.env` 和 `channels.yaml`，固定 Compose 项目名为 `inbox-server`。
- 部署后验证 Compose 配置、容器状态、健康信号、端口、重启策略和持久化卷。

**Non-Goals:**

- 不把 testing 主机升级为生产环境，不设计生产发布审批流。
- 不修改应用 API、业务逻辑、数据库 schema 或采集/分发规则。
- 不把敏感配置、SSH 私钥或 WebDAV 凭据写入仓库、Release 或日志。
- 不删除现有 `.github/workflows/ci.yml`。

## Decisions

1. git-manager 的自动部署作为显式配置启用，默认安全行为仍保留手动部署。这样 inbox-server 可选择自动 CD，同时不改变其它仓库的既有发布语义。备选方案是为 inbox-server 手写 workflow，但会绕过统一的 Git 交付入口。
2. 确定性标签使用 `release-<version>-<sha7>`。相同提交重跑时复用 Release，避免产生重复版本；版本来自 `git-manager.yml`。
3. 发布代码解压到不可变的 `releases/<tag>`，成功时切换 `current`；失败时恢复原软链接。备选方案是直接覆盖固定工作目录，但会降低回滚可靠性。
4. `.env` 与 `channels.yaml` 固定保存在 `shared`，部署入口在 Release 目录创建软链接。备选方案是由 Actions 写入配置，但这会扩大敏感信息暴露面并使多行配置难以维护。
5. Compose 命令固定使用项目名 `inbox-server`，防止发布目录变化导致 Postgres/Redis 命名卷漂移。
6. GitHub Environment 固定为 `testing`；主机、端口、用户、路径使用 Environment Variables，SSH 私钥和 known_hosts 使用 Environment Secrets。

## Risks / Trade-offs

- [testing 主机尚未信任专用部署公钥] → 先生成独立密钥并配置 GitHub secret；只有公钥加入服务器后才触发真实部署验收。
- [自动部署会把 `main` 的错误版本带到测试机] → 部署 job 依赖 CI，入口脚本失败时恢复 `current`，并保留手动回滚入口。
- [Release 切换与 Compose 状态并非单一事务] → 入口脚本在切换后执行配置校验和容器健康检查，失败由 workflow 恢复上一个软链接并重新执行入口。
- [共享配置格式错误会阻断新版本] → 部署前检查两个共享文件存在且非空，并执行 `docker compose config --quiet`。

## Migration Plan

1. 先为 git-manager 增加可选自动 Release/CD 能力并通过其测试。
2. 为 inbox-server 写入 git-manager 配置、部署入口和受管 workflows，通过静态与单元测试。
3. 在 GitHub `testing` Environment 配置变量、专用 SSH 私钥和固定 known_hosts。
4. 在服务器创建 `shared` 目录并放置现有 `.env`、`channels.yaml`，授权专用公钥。
5. 推送 `main`，等待 CI、Release 和部署完成，再检查容器、端口、重启策略和卷。
6. 部署失败时使用受管 workflow 的 rollback 操作恢复上一个 Release；共享配置和持久化卷不回滚。

## Open Questions

- testing 主机当前未接受本机已有 SSH 密钥，专用部署公钥仍需通过可用的服务器管理凭据加入 `root` 的 `authorized_keys`。
