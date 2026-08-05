## Why

当前运维依赖命令行、Docker 日志和多个独立 API，无法在一个入口确认调度是否生效、队列是否积压、同步为何失败以及文章是否已归档并推送。随着来源和分发链路增加，需要一个受鉴权保护、可追溯且不暴露敏感配置的可视化控制台。

## What Changes

- 新增 React + TypeScript 单页运维控制台，同源展示服务状态、调度状态、渠道、队列、最近同步和文章归档事件。
- 新增受 `X-API-Key` 保护的运维汇总与历史查询 API；页面仅在当前浏览器会话保存 API Key。
- 使用 PostgreSQL 持久化手动与定时同步运行记录，以及文章归档成功、已存在、跳过和失败事件。
- 在控制台开放手动同步；首版不提供清空队列、修改配置、编辑凭据或批量重试等高风险写操作。
- 将前端静态产物纳入 Nginx 镜像，由 Nginx 在单一宿主机端口提供页面并反向代理 FastAPI API。

## Capabilities

### New Capabilities

- `operations-console`: 提供受鉴权保护的运行状态读模型、持久化运行历史、文章归档事件和组件化 React 运维控制台。

### Modified Capabilities

- 无。

## Impact

- 受影响代码：FastAPI app/routes、scheduler、同步入口、文章归档服务、SQLAlchemy models/repositories、Alembic、Dockerfile、Nginx 与 Compose 部署配置。
- 新增代码：`web/` React 应用及其测试、运维查询 API、运行记录持久化适配器。
- 新增依赖：React/Vite/TypeScript 及前端测试工具；不新增 Python 生产依赖。
- 数据系统：PostgreSQL 新增文章归档事件表，并启用现有 `sync_jobs` 表作为同步运行历史。
- 对外兼容：保留现有 API 路径和响应；新增 `/api/operations/*` 与根路径 `/`，无破坏性变更。
