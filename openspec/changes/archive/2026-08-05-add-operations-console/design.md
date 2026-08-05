## Context

inbox-server 当前通过 FastAPI、APScheduler、Redis、PostgreSQL 和独立 worker 运行。管理能力分散在 `/healthz`、`/queue`、`/channels`、`/login/*`、Docker 日志和 Git 仓库中；`sync_jobs` 表已经存在但没有 Repository 和写入链路，文章归档只有结构化日志。控制台需要复用现有单端口部署、API Key 鉴权和 Compose 拓扑，并保持 worker 的 headed Chromium 与主消费流程不受 UI 影响。

## Goals / Non-Goals

**Goals:**

- 用一个响应式单页展示 server、worker、10 分钟调度、渠道、队列、同步历史和文章归档历史。
- 让手动与定时同步共用同一个运行记录函数，并将结果持久化到现有 `sync_jobs` 表。
- 将文章归档终态持久化到 PostgreSQL，同时确保记录失败不改变归档结果。
- 复用 `X-API-Key`，仅在浏览器 `sessionStorage` 保存用户输入的 Key。
- 在构建阶段生成 React 静态资源，由 Nginx 提供页面并在同一 origin 反向代理 FastAPI。

**Non-Goals:**

- 不修改 `channels.yaml`、调度间隔、凭据或限速配置。
- 不清空队列、不批量重试 DLQ、不重启容器。
- 不提供多用户、角色权限、服务端登录 Session 或公网部署能力。
- 不迁移历史 Docker 日志或补录历史文章事件。

## Decisions

### React + TypeScript + Vite 单页，由 Nginx 统一同源入口

前端放在 `web/`，构建产物由 Nginx 提供 `/` 与 `/assets/*`，其它路径原样反向代理到内部 FastAPI。宿主机只暴露 Nginx 的 `127.0.0.1:8000`，避免 CORS 和第二套认证边界；FastAPI 保留静态交付能力作为镜像内回退，但不再直接暴露端口。备选由 FastAPI 直接提供页面虽然容器更少，但把静态资源交付和 API 生命周期耦合；Next.js 会增加 Node 运行服务与部署状态，不符合轻量运维控制台目标。

### 使用面向控制台的聚合读 API

新增 `/api/operations/overview`，一次返回调度、worker 心跳、渠道、四类队列及最近历史，减少首屏请求瀑布。独立历史接口保留分页上限，便于组件刷新。现有 `/queue`、`/channels` 和 `/sync` 保持兼容，不让 UI 直接拼装内部 Redis Key。

### PostgreSQL 保存终态历史，Redis 保存短期心跳

复用 `sync_jobs` 保存同步运行状态；新增 `article_archive_events` 保存文章归档终态。worker 每 30 秒写入带 90 秒 TTL 的心跳键，控制台只将 TTL 内心跳判为在线。历史是长期状态，不能只依赖日志或 Redis；心跳是瞬时状态，不进入数据库。

### 记录链路采用失败隔离

同步运行记录通过共享函数包裹 `run_collect`；开始、完成或失败均提交状态。文章归档服务接收可选异步 recorder，在每个终态尝试写入，recorder 异常只写告警，不反转归档成功或跳过结果。错误字段只保存安全错误码或异常类型，不保存凭据和网页正文。

### 浏览器 API Key 仅保存在当前会话

静态页面可公开加载，但所有运维数据和操作继续要求 `X-API-Key`。前端不把 Key 写入 URL、日志或长期存储；401 时清除会话 Key 并返回解锁界面。备选将 Key 编译进页面会泄露秘密，localStorage 会扩大驻留时间。

## Risks / Trade-offs

- [单次聚合 API 查询多种依赖，任一依赖可能拖慢首屏] → 对 Redis 与数据库采用已有连接超时，响应保留明确错误态，前端提供重试。
- [worker 心跳可能在短暂停顿时误报离线] → TTL 设为写入周期三倍，并显示最后心跳时间而不是只有布尔值。
- [文章事件表持续增长] → 首版只提供有上限的倒序查询；后续基于实际规模增加保留策略，不预先删除历史。
- [前端 API 类型与后端响应漂移] → 使用固定 TypeScript 类型、FastAPI 集成测试和前端契约样例共同约束公共边界。
- [记录数据库短暂失败] → 文章记录失败隔离；同步记录失败只记录告警并继续主同步，控制台明确可能缺少历史而不伪造结果。

## Migration Plan

1. 先应用 Alembic 迁移新增 `article_archive_events`。
2. 部署包含静态资源的 Nginx 镜像，以及 API、同步记录和 worker 心跳的新应用镜像。
3. 依次验证迁移、内部 server 健康、Nginx 健康、worker 心跳、`/api/operations/overview` 和根页面。
4. 回滚时恢复上一镜像；新增表保留且不影响旧代码，避免破坏性 downgrade。

## Open Questions

- 暂无；高风险写操作、服务端 Session 和事件保留策略留待后续独立变更。
