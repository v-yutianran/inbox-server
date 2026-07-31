---
status: accepted
---

# 采用 TypeScript、Cloudflare 与 Docker Worker 混合架构

当前 FastAPI、PostgreSQL、Redis、Nginx 与 Python worker 的组合使应用契约和部署边界分散，而 headed Playwright 又无法安全迁入 Cloudflare Workers。决定将 console、Hono API、D1 与 Queues 部署到 Cloudflare，并把使用 Chromium/Xvfb 的 TypeScript worker 作为独立 Docker 服务部署到 Sealos；迁移采用可回滚的纵向切片，现有 Python 服务在功能与数据门槛通过前继续保留。

具体范围、兼容要求和切换门槛见 [`migrate-to-typescript-cloudflare`](../../openspec/changes/migrate-to-typescript-cloudflare/proposal.md)。
