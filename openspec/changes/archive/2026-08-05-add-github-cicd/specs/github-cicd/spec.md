## ADDED Requirements

### Requirement: 默认分支质量门禁
系统 MUST 在 `main` 更新和面向 `main` 的拉取请求上执行 ruff、非 E2E pytest 与 mypy 检查，任一检查失败时不得执行自动部署。

#### Scenario: 质量门禁失败
- **WHEN** 任一必需检查返回非零状态
- **THEN** 系统 MUST 将 CI 标记为失败且不得启动 testing 部署

### Requirement: 确定性 Release
系统 SHALL 对通过质量门禁的 `main` 提交使用 `release-<version>-<sha7>` 标签创建或复用 GitHub Release，并附加该提交的代码 ZIP。

#### Scenario: 同一提交重新运行
- **WHEN** 同一版本和提交的自动发布 workflow 再次执行
- **THEN** 系统 MUST 复用既有标签与 Release，不得创建第二个发布标识

### Requirement: 隔离的 SSH 部署凭据
系统 MUST 从 GitHub `testing` Environment 读取部署主机、端口、用户、目录、专用 SSH 私钥和固定 known_hosts，且不得把私钥或运行配置写入仓库、Release 或日志。

#### Scenario: 部署凭据不完整
- **WHEN** 任一必需的 Environment Variable 或 Secret 缺失
- **THEN** 系统 MUST 在建立 SSH 连接前失败并指出缺失的配置名称

### Requirement: 发布与共享配置分离
系统 SHALL 把代码解压到 `/apps/inbox-server/releases/<tag>`，通过 `/apps/inbox-server/current` 指向当前版本，并从 `/apps/inbox-server/shared` 复用非空的 `.env` 与 `channels.yaml`。

#### Scenario: 共享配置缺失
- **WHEN** `.env` 或 `channels.yaml` 不存在或为空
- **THEN** 部署入口 MUST 失败且不得启动新版本容器

### Requirement: Docker Compose 数据连续性
系统 MUST 使用固定 Compose 项目名 `inbox-server` 启动 server、worker、Postgres 和 Redis，使发布目录切换前后继续复用既有持久化卷。

#### Scenario: 新 Release 启动
- **WHEN** `current` 从旧 Release 切换到新 Release
- **THEN** Compose MUST 使用项目名 `inbox-server` 且 Postgres、Redis 的持久化卷标识保持不变

### Requirement: 部署验收与回滚
系统 MUST 在部署后验证 Compose 配置、必需容器状态、server 健康信号、端口、重启策略和持久化卷；部署入口失败时 MUST 恢复上一个 `current` 目标并重新启动旧版本。

#### Scenario: 新版本健康检查失败
- **WHEN** 新版本容器启动后 server 健康信号未在限定时间内成功
- **THEN** workflow MUST 恢复上一个 Release 的软链接并执行旧版本部署入口

#### Scenario: 手动回滚
- **WHEN** 操作者通过受管 workflow 选择 rollback
- **THEN** 系统 MUST 切换到上一个有效 Release，且不得改写共享配置或删除持久化卷
