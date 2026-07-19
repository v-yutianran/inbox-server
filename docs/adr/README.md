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
