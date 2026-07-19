## 1. 持久化与运行记录

- [x] 1.1 先写失败测试，再实现 `SyncJobRepo` 与共享同步运行记录函数
- [x] 1.2 先写失败测试，再新增文章归档事件模型、Repository 和 Alembic 迁移
- [x] 1.3 先写失败测试，再让文章归档各终态进行失败隔离的事件记录

## 2. 运维 API 与心跳

- [x] 2.1 完成 GitNexus 影响分析并接入手动、定时同步运行记录
- [x] 2.2 先写失败测试，再实现 worker Redis TTL 心跳
- [x] 2.3 先写失败测试，再实现受鉴权保护的运维汇总与历史 API
- [x] 2.4 先写失败测试，再让 FastAPI 明确提供根页面与静态资源且不遮蔽既有路由

## 3. React 控制台

- [x] 3.1 配置 React、TypeScript、Vite、Vitest 和前端构建脚本
- [x] 3.2 先写失败测试，再实现 sessionStorage 鉴权与类型化 API client
- [x] 3.3 先写失败测试，再实现响应式状态卡、渠道、队列、同步历史和文章历史组件
- [x] 3.4 先写失败测试，再实现手动同步、刷新、加载和错误反馈
- [x] 3.5 将前端构建纳入 Docker 多阶段镜像

## 4. 文档、验证与交付

- [x] 4.1 创建 React 同源运维控制台 ADR 并更新 CHANGELOG
- [x] 4.2 运行前端测试/类型检查/构建和后端四件套验证
- [x] 4.3 运行 OpenSpec、docs-manager 与 GitNexus 变更检查
- [ ] 4.4 重建 server/worker，验证迁移、健康、心跳、API、页面与 10 分钟调度
- [x] 4.5 精确暂存本变更，commit、push 并确认远端一致
