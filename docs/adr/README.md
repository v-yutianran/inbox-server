# Architecture Decision Records

记录难以逆转、令人意外且经过真实权衡的架构决定。

## 应包含

- 架构边界决定
- 关键技术选型
- 上下文集成模式
- 非显而易见的约束

## 不应包含

- 普通实现选择、会议纪要和易于撤销的决定不写 ADR。

## 索引

- [0001：使用 GitHub Actions 发布并部署 Docker Compose 服务](./0001-github-actions-docker-deployment.md) — 固定 Release、共享配置和 Compose 项目名，保证自动部署时凭据与持久化数据连续。
- [0002：使用本地 Git 仓库交付文章归档](./0002-local-git-article-archive.md) — 由 worker 将文章写入 `.agents`、按原始 URL 去重并立即提交推送。
- [0003：React 运维控制台与 FastAPI 同源交付](./0003-react-operations-console.md) — 使用 React 组件化控制台并复用 FastAPI 单端口与 API Key 鉴权边界。
- [0004：采用 TypeScript、Cloudflare 与 Docker Worker 混合架构](./0004-typescript-cloudflare-docker-worker.md) — console 与 API 迁入 Cloudflare，headed Playwright worker 继续以 Sealos Docker 服务运行。
- [0005：Cloudflare Queues 先落 D1 再由 Sealos 领取](./0005-stage-cloudflare-queues-in-d1.md) — Queue consumer 先持久化 D1 租约，Sealos 不持有 Cloudflare 个人令牌。
- [0006：使用 WARP Sidecar 提供受控出站网络](./0006-warp-egress-sidecar.md) — 官方 WARP 与本地 DoH/CONNECT 适配器为 Sealos worker 提供不依赖本机代理的出站能力。
