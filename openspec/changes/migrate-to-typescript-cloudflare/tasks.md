## 1. 架构与基线

- [x] 1.1 建立 OpenSpec proposal/design/specs 与 ADR-0004，并通过 docs-manager 审计
- [x] 1.2 刷新 GitNexus 索引并完成 worker cloud-native readiness 与现有 Docker artifact 评估
- [x] 1.3 依据官方文档固定 Hono、Drizzle、Wrangler、Playwright 与 Sealos 模板所需镜像版本
- [x] 1.4 记录现有 API 路由、数据库表、队列键、来源、目标、限速、定时任务和凭据状态的兼容基线

## 2. npm TypeScript 工作区

- [x] 2.1 备份现有 Node 清单并把根项目迁为 npm workspace，生成并校验 `package-lock.json`
- [x] 2.2 建立 strict 共享 tsconfig、Vitest 15 秒全局超时和各 workspace 的独立 typecheck/test/build 命令
- [x] 2.3 在 `packages/domain` 先写失败测试，再实现版本化任务联合类型、运行时解析和稳定幂等键
- [x] 2.4 将现有 `web` console 迁入 `apps/console`，保持组件化 UI、现有测试与 Cloudflare 静态构建通过

## 3. Cloudflare API 与持久化

- [x] 3.1 建立 `apps/api` Hono Worker、环境绑定类型、健康端点和本地 Wrangler 配置
- [x] 3.2 先写认证契约测试，再实现兼容 `X-API-Key` 的外部认证与独立 worker service token
- [x] 3.3 建立 Drizzle D1 schema、版本化 migration 与空库/重复应用测试
- [x] 3.4 实现 Queue producer 适配器与 Cron Trigger 到期任务发布，验证未知消息在发布前被拒绝
- [x] 3.5 按 API 影响分析逐个迁移现有运维端点，并为响应 shape 与状态码补充兼容测试

## 4. Docker worker 核心

- [x] 4.1 建立 `apps/worker` 配置边界、结构化日志、AbortSignal 生命周期和 liveness/readiness 服务
- [x] 4.2 先写 pull/ack/retry/lease 契约测试，再实现 Cloudflare Queues HTTP pull consumer 适配器
- [x] 4.3 实现任务幂等仓储与死信错误分类，验证业务状态持久化前不会 ack
- [x] 4.4 建立固定版本 Playwright Dockerfile 与 Xvfb 入口，验证 Node 为 PID 1 且 SIGTERM 可优雅退出
- [x] 4.5 实现加密登录态适配器与 Sealos PVC 路径，验证日志不包含 Cookie、token 或完整 payload

## 5. 来源、目标与归档迁移

- [x] 5.1 迁移一个无浏览器、无外部分发副作用的 collector，并完成新旧 shadow 契约对比
- [x] 5.2 迁移一个 browser source，验证 headed Chromium、基线导入、来源键与去重键功能对等
- [x] 5.3 逐项迁移剩余 HTTP/browser sources，并更新 parity checklist 与对应测试
- [x] 5.4 逐项迁移 Cubox、Flomo、坚果云、通知与限速策略，并验证至少一次投递下不重复副作用
- [x] 5.5 迁移 Defuddle/Eta 与 Git 文章归档，验证 Sealos PVC 重建后的仓库与去重状态

## 6. 数据迁移与双跑

- [x] 6.1 实现 PostgreSQL 稳定快照导出、D1 幂等导入和按表计数/主键/不变量核对工具
- [x] 6.2 使用本地或临时 D1 重复执行全量导入，生成不含敏感数据的核对报告
- [x] 6.3 在禁用外部分发的 shadow 模式运行代表性任务，核对解析、凭据、幂等和错误分类
- [ ] 6.4 演练停止新 worker 并恢复现有 Docker Compose 的回滚路径，不删除旧数据或服务

## 7. Sealos worker 部署

- [x] 7.1 生成 worker-only Sealos 模板、TopologyEvidence、固定镜像、PVC、Secret、探针和单副本 StatefulSet
- [x] 7.2 运行 docker-to-sealos 全部静态校验与模板质量门禁
- [x] 7.3 构建 worker `linux/amd64` 镜像并完成本地配置、健康、SIGTERM 和持久化非 E2E 验证
- [x] 7.4 部署到 `sealos.run` 北京区 `bja`、工作区 `ns-tbs948af` 的 staging，并确认无公网 Ingress
- [x] 7.5 按浏览器资源阶梯完成冷启动、轻量页、真实页、一次交互和 60 秒稳定性手工验收
- [x] 7.6 部署固定版本 WARP sidecar 与持久化注册状态，验证非 root、无额外 capability、`warp=on` 和受限站点真实连通

## 8. Cloudflare 与生产切换

- [x] 8.1 在本地/预览环境应用 D1 migration、Queues 与 Cron 配置并验证 API/worker 端到端契约
- [x] 8.2 部署 console/API 预览环境，完成非 E2E 自动检查并提供手工 UI 与真实凭据验收清单
- [x] 8.3 经用户确认生产迁移窗口后停止旧 worker，执行最终增量迁移并启用新队列单一生产者
- [x] 8.4 完成生产观察与回滚门槛检查；仅在另行确认后下线 Python/PostgreSQL/Redis/Nginx 路径

## 9. 完成门禁

- [x] 9.1 运行 npm typecheck/test/build、Python 既有四件套中适用项、Docker 与 OpenSpec validate
- [x] 9.2 运行 GitNexus detect changes，确认仅影响预期符号、API 路由和执行流
- [x] 9.3 更新 CHANGELOG、长期文档链接和手工验收记录，并通过 docs-manager audit
- [x] 9.4 按 git-manager 精确路径 dry-run 后创建本地原子提交；未经单独授权不 push、不建 PR
