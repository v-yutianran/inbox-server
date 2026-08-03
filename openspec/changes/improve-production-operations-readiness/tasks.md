## 1. 实现前门禁与基线

- [x] 1.1 串行调用 `requirements_designer`，基于本 change 产出需求文档并读回确认需求 ID、非目标、业务规则和验收标准
- [x] 1.2 串行调用 `technical_designer`，基于已确认需求产出技术设计并读回确认接口、数据、迁移、回滚和质量属性
- [x] 1.3 串行调用 `acceptance_designer`，产出追踪矩阵与验收用例并读回确认无阻塞项
- [ ] 1.4 采集连续 14 天 API、Worker、队列、浏览器、Mihomo、WARP、D1 大小和 Sealos 资源基线，脱敏保存聚合证据
  - 已实现按自然日幂等聚合并持久化 7/30/90 天 retention 样本；生产 migration 尚未部署，连续 14 天观察窗口尚未开始
- [x] 1.5 对将修改的函数、路由和部署流程逐项运行 GitNexus upstream/API impact analysis，HIGH/CRITICAL 结果先报告

## 2. P0 健康状态与回滚闭环

- [x] 2.1 RED：为 Worker 状态机、健康服务独立响应、代理未就绪停止领取、优雅退出和探针预算补失败测试
- [x] 2.2 GREEN：实现 Worker、浏览器、Mihomo、WARP 的分层状态快照，并让健康服务不等待工作负载 IO
- [x] 2.3 GREEN：调整 Sealos startup/liveness/readiness probes 和 shutdown grace period，保持单副本与现有 PVC 不变
- [x] 2.4 REFACTOR：把状态转换和任务领取决策收敛为纯函数，IO 边界只负责记录稳定事件
- [ ] 2.5 在隔离环境完成迁移任务 6.4 的旧 Docker Compose 回滚演练，验证备份、Cloudflare 版本、Worker digest 和 D1 兼容性
- [ ] 2.6 验证连续 24 小时无探针超时，WARP 冷启动与 Worker 停止/恢复事件符合预期

## 3. P0 队列、DLQ 与隔离 canary

- [x] 3.1 RED：为 backlog oldest age、DLQ/dead 差异分类、逐条重放、幂等冲突和限速拒绝补契约测试
- [x] 3.2 GREEN：实现只读队列一致性报告，解释当前 238 条 DLQ 与 224 条 dead job 的 14 条差异且不删除记录
- [x] 3.3 GREEN：扩展重放审计状态和运维 API，所有重放与清理入口先支持同参数 dry-run
- [x] 3.4 RED：为 direct Defuddle 成功、短内容拒绝、Playwright 回退成功和目标 sink 零副作用补 canary 测试
- [x] 3.5 GREEN：实现使用固定 fixture、dry-run destination 和 canary 标识的端到端测试任务
- [x] 3.6 REFACTOR：统一任务、租约、提取路径和结算的关联字段及稳定事件，复用现有领域契约
- [ ] 3.7 获得当前任务的自动化 E2E 授权后在线触发 canary，检查 API、Worker 和 D1 日志；未获授权时仅交付手工验证清单

## 4. P1 指标、SLO 与告警

- [x] 4.1 RED：为稳定事件字段、敏感值过滤、指标聚合、窗口趋势和 SLO 越界补测试
- [x] 4.2 GREEN：在 API 与 Worker IO 边界生成低基数指标，覆盖可用性、心跳、积压年龄、处理结果、提取路径和依赖状态
- [x] 4.3 GREEN：扩展运维 API 与组件化 Console，展示当前值、趋势、阈值、采集时间和部署版本
- [ ] 4.4 GREEN：配置 P0 告警及恢复通知，完成一次不触发真实副作用的告警演练
  - 已实现候选阈值的 `pending` / `firing` / `recovered` 状态持久化、审计事件和脱敏日志；外部告警通道仍受 `OPEN-001` 约束，本任务保持未完成
- [x] 4.5 REFACTOR：建立事件与指标目录，删除本次新增的重复计算，不把副作用引入领域纯函数
- [ ] 4.6 根据 14 天基线确认最终 SLO、错误预算和告警窗口，记录调整依据

## 5. P1 可重复发布、回滚与配置安全

- [x] 5.1 RED：为发布计划、migration 顺序、digest 固定、Secret 引用、失败停止和回滚选择补纯函数/脚本测试
- [x] 5.2 GREEN：用 CAC TypeScript CLI 编排备份、预检、Cloudflare/Sealos 部署、线上验证和回滚，并支持全链路 `--dry-run`
- [x] 5.3 GREEN：输出源码提交、Cloudflare deployment/version、D1 migration、三容器 digest、Sealos revision 和验证结果的脱敏发布清单
- [x] 5.4 GREEN：在 API 与 Worker 启动边界强校验必需配置，验证 Console 管理 Key 不进入构建产物、日志或长期存储
- [x] 5.5 REFACTOR：将当前手工命令收敛到唯一发布入口，GitHub Actions 恢复后仅迁移执行环境而不复制发布逻辑
- [x] 5.6 演练“预检失败不部署”“Worker 回退上一 digest”“API 回退上一版本”三条路径并检查稳定事件

## 6. P1 数据生命周期

- [x] 6.1 RED：为心跳、完成任务、envelope、DLQ、重放审计和 effect 的保留条件补 migration/查询测试
- [ ] 6.2 GREEN：实现只读 retention report 和 14 天 dry-run，输出候选数量、最老/最新时间和幂等风险
  - 只读 report 与每日 7/30/90 天聚合已实现并覆盖同日并发幂等测试；实际 14 天 dry-run 仍待生产观察窗口
- [ ] 6.3 GREEN：经保留期限确认后实现分批、可中断、带审计的清理任务，并避免长事务和全表扫描
- [x] 6.4 REFACTOR：基于 D1 查询计划补必要索引，删除重复扫描并验证 migration 前后数据契约
- [ ] 6.5 验证备份、清理、恢复和记录数对账，不使用真实数据做试验性恢复，除非另获明确授权

## 7. P2 容量、成本与高可用决策

- [x] 7.1 RED：定义不写真实外部目标的负载模型，覆盖到达率、消化率、长浏览器任务、重复投递和代理重连
- [ ] 7.2 GREEN：记录 CPU、内存、重启、任务 P50/P95、队列增长率、D1/日志用量与月度成本趋势
- [ ] 7.3 完成 Worker、浏览器状态和 WARP 状态备份恢复演练，验证 RTO 15 分钟及最终确认的 RPO
- [ ] 7.4 完成多副本租约、幂等、副作用、归档锁和登录态隔离测试，形成 active-passive、分片或维持单副本的决策数据
- [ ] 7.5 若决定启用多副本或外部 APM，先使用 `docs-manager` 新建并批准独立 ADR；否则记录容量上限与降级策略
- [ ] 7.6 在旧 Compose 回滚窗口结束且获得删除授权后，另行制定 Python 运行时和旧部署资产的收敛计划

## 8. 验证与交付

- [x] 8.1 更新 `CHANGELOG.md`、`roadmap.md`、运维 runbook 和 ADR 索引，明确旧 `docs/optimization-plan.md` 只描述历史 Python 优化
- [x] 8.2 运行 `npm run typecheck`、`npm test`、`npm run build` 和适用的 Python 自验四件套
- [x] 8.3 运行 Docker 构建/健康检查、D1 migration dry-run、Sealos manifest 静态检查和脱敏日志断言
- [x] 8.4 运行 `/Users/xinwu/Library/pnpm/bin/openspec validate improve-production-operations-readiness --strict --no-interactive` 与 docs-manager audit
- [x] 8.5 运行 GitNexus `detect-changes --scope compare --base-ref main`，确认只影响预期符号、路由和执行流
- [x] 8.6 按 git-manager 精确路径 dry-run 后原子提交并推送功能分支；没有开放 PR 时创建 PR，不自动合并
