---
status: accepted
---

# React 运维控制台与 FastAPI 同源交付

当前管理能力分散在 API、Docker 日志和 Git 仓库，且系统已由 FastAPI、worker、Redis 与 PostgreSQL 组成。决定使用 React + TypeScript + Vite 构建组件化运维控制台，并由 FastAPI 同源提供静态资源和受 `X-API-Key` 保护的聚合 API；相比新增 Next.js 服务或服务端模板，该方案保留单端口部署和单一认证边界，同时满足持续交互与类型化前端的需要。具体需求与实施范围见 [`add-operations-console`](../../openspec/changes/add-operations-console/proposal.md)。
