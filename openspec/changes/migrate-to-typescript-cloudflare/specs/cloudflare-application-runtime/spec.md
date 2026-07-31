## ADDED Requirements

### Requirement: 可独立部署的 TypeScript 单元
系统 SHALL 使用 strict TypeScript 将 console、API、worker 与纯领域包划分为可独立构建和部署的 workspace 单元，领域包 MUST 不依赖浏览器、数据库、网络或云平台 IO。

#### Scenario: 独立构建 API
- **WHEN** 只安装仓库锁定依赖并执行 API 构建命令
- **THEN** 系统生成可由 Cloudflare Workers 加载的产物，且不要求启动 console 或 Docker worker

#### Scenario: 领域策略保持纯函数
- **WHEN** 单元测试以输入值调用领域策略
- **THEN** 结果只由显式输入决定，且测试不访问文件、网络、数据库、时间源或环境变量

### Requirement: Cloudflare API 兼容现有契约
系统 SHALL 由 Hono Worker 提供 API，并 MUST 保持已迁移 REST 端点的路径、状态码、响应字段和 `X-API-Key` 认证语义兼容。

#### Scenario: 有效 API Key 请求
- **WHEN** console 使用有效 `X-API-Key` 请求已迁移端点
- **THEN** API 返回与迁移前契约相同语义的成功响应

#### Scenario: 无效 API Key 请求
- **WHEN** 客户端省略或提供无效 `X-API-Key`
- **THEN** API 拒绝请求且不返回受保护业务数据

### Requirement: D1 持久化与版本迁移
系统 MUST 使用 Drizzle schema 和版本化 SQL migration 管理 D1 结构，并 SHALL 为从 PostgreSQL 导入的数据提供可重复执行的核对流程。

#### Scenario: 空数据库应用迁移
- **WHEN** 对空 D1 数据库依序应用全部 migration
- **THEN** 数据库结构与当前 Drizzle schema 一致且所有 migration 成功记录

#### Scenario: 重复导入稳定快照
- **WHEN** 对同一 PostgreSQL 稳定快照重复执行导入与核对
- **THEN** D1 的稳定主键集合、记录数和关键不变量保持一致且不产生重复记录

### Requirement: 版本化队列消息
系统 SHALL 以带判别字段的版本化消息向 Cloudflare Queues 发布任务，消息 MUST 包含稳定任务标识、幂等键、创建时间和经过运行时验证的 payload。

#### Scenario: 发布有效任务
- **WHEN** API 或 Cron Trigger 创建满足当前 schema 的任务
- **THEN** Queue 收到包含 `schemaVersion`、`jobId`、`kind`、`dedupeKey` 与 `createdAt` 的消息

#### Scenario: 拒绝未知任务
- **WHEN** 外部输入缺少必填字段或使用未知消息版本
- **THEN** 系统在发布前拒绝输入并记录不含敏感 payload 的结构化错误

### Requirement: 定时任务只负责发布
Cloudflare Cron Trigger SHALL 只计算到期任务并发布队列消息，不得在触发请求内运行 headed 浏览器或无界后台循环。

#### Scenario: 到期 browser source
- **WHEN** Cron Trigger 检测到 browser source 已到采集时间
- **THEN** 系统发布一次带稳定幂等键的采集任务并在 Worker 执行上限内结束

### Requirement: 可回滚切换
系统 MUST 在生产切换前完成数据核对、禁用副作用的 shadow 运行、幂等验证和回滚演练；任一门槛失败时 SHALL 保持现有 Python 服务为权威运行路径。

#### Scenario: 迁移门槛未通过
- **WHEN** 数据计数、关键不变量、任务结果、凭据解密或幂等检查任一失败
- **THEN** 系统不得启用新生产者或停止现有 Python 服务

#### Scenario: 切换后发现异常
- **WHEN** 新运行路径在观察期出现重复分发、数据缺失或持续健康失败
- **THEN** 运维人员可以停止新 worker 并恢复旧 Compose，而无需从新系统反向重建权威数据
