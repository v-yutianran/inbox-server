# Inoreader 生产复验需求基线

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 变更 | `fix-inoreader-pagination-notifications` |
| 版本 | 1.0 |
| 日期 | 2026-08-05 |
| 状态 | 已确认；生产执行已获授权 |
| 事实来源 | `proposal.md`、两份 delta spec、`design.md`、`acceptance.md`、`tasks.md` |

## 背景与问题

Inoreader 使用虚拟列表和 SPA 延迟渲染。旧 Worker 可能在文章节点出现前提取，或只按当前 DOM 数量判断停止，从而把尚未就绪或同数量换页误判为零新增。通知同时使用“发布”措辞，容易被理解为目标目录已经保存成功。代码修复已在提交 `96cd3f8a467a148b523037e9c96862084032b7be` 完成本地验证，但生产 Worker 尚未更新，生产去重与分发闭环仍缺证据。

## 目标与成功指标

- 仅更新 Sealos 北京区工作区 `ns-tbs948af` 的 Worker 主容器，Mihomo 与 WARP 保持原镜像和配置。
- 部署后 Worker、Mihomo、WARP 三个容器均 Ready，Worker heartbeat、浏览器运行时和任务领取正常。
- 第一次 Inoreader 单来源采集发现预检确认的新增数量 `N`；当前验收基线预期 `N=3`，若实时预检表明收藏状态已漂移，则记录实际 `N` 并以实际值判定，不伪造 3 条结果。
- 第一次运行满足 `collected=N`、`published=N`、baseline 从 `B0` 单调增加 `N`，每条新内容各有成功 dispatch job 与 effect，且本次任务只发送一条“已入队”通知。
- 使用新 run id 的第二次运行满足 `collected=0`、`published=0`，不新增 dispatch、effect、通知或 DLQ。
- 部署或业务门禁失败时回滚到预检冻结的旧 Worker 镜像 digest，并恢复 Ready 与任务领取。

## 非目标

- 不修改 Cloudflare API、Console、D1 schema、Queues 配置或 Pages 部署。
- 不重置、删除或手工补写 Inoreader baseline。
- 不重放、删除或改写 DLQ；只记录前后计数。
- 不修改 Mihomo、WARP 镜像、网络配置、Secret、PVC、Service 或 Ingress。
- 不自动逆转已经发生的第三方保存、邮件或 Telegram 副作用。
- 不执行 PR merge、Release、Cloudflare 部署或其它生产来源采集。

## 用户、参与者与外部系统

- 甲方爸爸：批准限定范围部署、两次真实 Inoreader 复验以及失败时 Worker 镜像回滚。
- 执行 Agent：记录回滚锚点、执行 dry-run、部署、验证、回填证据和本地 Git 提交。
- Sealos：托管 Worker、Mihomo、WARP 三容器 Pod 与持久浏览器状态。
- Cloudflare API：现有任务、baseline、dispatch/effect、通知和 DLQ 的权威状态源；本任务只通过现有接口读写正常业务数据，不改平台配置。
- Inoreader：真实收藏来源；只触发已授权的两次单来源采集。

## 范围

### 包含项

- 生产前工具、认证、命名空间、现有 Deployment/Pod、回滚 digest、B0、待处理任务和 DLQ 只读预检。
- 构建并推送提交 `96cd3f8a467a148b523037e9c96862084032b7be` 对应的公开 GHCR Worker 镜像，Sealos 使用南京大学代理的同一 digest。
- 对现有 Worker Deployment 做主容器镜像差异预检、滚动更新、稳定窗口检查和必要时精确回滚。
- 两次不同 run id 的 Inoreader 生产采集及业务后置条件核对。
- 回填 OpenSpec 任务、验收证据、CHANGELOG，并在门禁通过后创建精确本地提交。

### 排除项

非目标中列出的所有平台、数据和外部动作均排除；任何预检发现需要扩大范围才能继续时必须停止。

## 需求清单

- **REQ-001（P0）部署身份冻结**：执行前 MUST 记录待部署源提交、当前主容器镜像 digest、三个容器 Ready、Worker heartbeat、B0、待处理任务和 DLQ 计数，并保存不含秘密的部署日志。
- **REQ-002（P0）限定 Worker 更新**：系统 MUST 只改变现有 Sealos Worker Deployment 的主容器镜像；Mihomo、WARP、Secret、PVC、Cloudflare 资源和业务数据结构 MUST 保持不变。
- **REQ-003（P0）运行时就绪**：新 Pod MUST 在 rollout 时限内达到三个容器 Ready，Worker MUST 报告目标 source revision、目标 digest、有效 heartbeat 和可用浏览器依赖。
- **REQ-004（P0）首次真实采集**：第一次新 run id MUST 以实时新增量 `N` 完成采集、baseline 单调合并、逐条 dispatch/effect 成功和单次“已入队”通知；任何文章未就绪、登录失效或分发失败 MUST 显式失败。
- **REQ-005（P0）第二次去重闭环**：第二次新 run id MUST 返回 `0/0`，且 dispatch、effect、通知和 DLQ 增量均为 0。
- **REQ-006（P0）失败回滚**：部署、就绪、采集、分发或健康门禁失败时 MUST 恢复预检冻结的旧 Worker digest，并重新证明 Ready、heartbeat 与任务领取；baseline 不做人工回退。
- **REQ-007（P1）证据与交付**：执行结果 MUST 回填到 `acceptance.md`、`tasks.md` 和 `CHANGELOG.md`；验证通过后只提交本任务路径，push、PR 和 merge 仍分别服从当前 Git 授权。

## 业务规则与状态

- baseline 只能按本次新发现的稳定 article key 单调合并，禁止删除或替换既有 key。
- 运行状态按 `预检完成 → 镜像可验证 → rollout 完成 → 运行时稳定 → 首次采集通过 → 第二次去重通过 → 验收完成` 前进；任一 P0 门禁失败进入 `回滚中`，回滚验证通过后状态为 `已回滚`，不得宣告生产验收通过。
- `published` 保留内部字段名，但用户可见通知必须表达“已入队”，不得声称已最终保存。
- 实时新增量与设计时的 3 条预期不一致属于可记录的外部状态漂移；使用实时 `N` 判定，但 `N=0` 时不能证明非零采集链路，TC-011 只可判为部分通过。

## 数据、安全与权限边界

- 不在命令输出、日志、文档、提交或回复中记录 API key、Cookie、Token、Secret、账号密码或文章正文。
- 生产查询只输出计数、run id、job/effect 标识、状态、时间、镜像 digest 和 source revision 等低敏证据。
- 真实数据授权仅覆盖两次 Inoreader 单来源运行及其自然产生的 dispatch/effect/通知；其它来源和人工 DLQ 操作不在授权内。
- 回滚仅改变 Worker 主容器镜像；禁止删除资源或修改持久状态。

## 非功能需求

- 所有部署写动作前 MUST 有同参数 dry-run 或差异预检。
- rollout 后 MUST 至少经历 60 秒稳定窗口，期间无新重启、Ready 抖动、活动失败事件或重复 traceback。
- 镜像 MUST 以不可变 digest 部署；Sealos 拉取地址 MUST 使用 `ghcr.nju.edu.cn` 代理且与公开 GHCR digest 一致。
- 所有操作必须可审计且可回滚，部署日志不得包含秘密。

## 验收标准

- **AC-001**：预检记录包含提交、旧 digest、三个容器状态、heartbeat、B0、待处理和 DLQ 计数，且部署差异只指向 Worker 主容器镜像。
- **AC-002**：新镜像可公开解析，代理 digest 与源 GHCR digest 一致，rollout 后三个容器 Ready 且 source revision 为目标提交。
- **AC-003**：60 秒稳定窗口内 Pod 无重启增量、Ready 抖动、活动失败事件或未解决 Secret 错误。
- **AC-004**：首次运行的 `collected/published/baseline` 增量都等于实时 `N`；存在 `N` 个成功 dispatch job 与 effect，通知增量为 1 且文案为“已入队”。
- **AC-005**：第二次运行 `0/0`，baseline 不变，dispatch、effect、通知和 DLQ 增量均为 0。
- **AC-006**：任一 P0 门禁失败时旧 digest 恢复，三个容器重新 Ready，Worker heartbeat 与任务领取恢复，且文档结论明确为已回滚而非通过。
- **AC-007**：OpenSpec、验收设计、CHANGELOG、GitNexus 和仓库适用验证全部通过，提交只包含生产证据相关路径。

## 依赖与边界

- 依赖有效的 Sealos kubeconfig、Docker/buildx、公开 GHCR 推送权限、现有 Worker Secret/PVC 与 Cloudflare 管理接口。
- 依赖 Inoreader 登录态仍有效；登录失效属于业务失败并触发回滚判定，不授权绕过认证。
- GitHub Actions 资金暂停不作为本次本地构建、Sealos 部署和本地门禁的替代证据。

## 假设

- 合并提交 `96cd3f8a467a148b523037e9c96862084032b7be` 是待部署代码身份。
- 现有 Deployment 的主容器名和三容器拓扑在预检时可被唯一识别。
- 当前 3 条新增收藏可能随时间漂移，实时预检值 `N` 是执行判定依据。

## 风险

- Inoreader 外部状态可能导致 `N=0`，此时第二次去重仍可验证，但非零采集链路不能宣告完整通过。
- 第三方 dispatch 已发生后无法安全自动逆转，故失败回滚只恢复运行时镜像。
- 代理缓存传播可能短暂延迟，必须以 digest 解析和 Pod 实际 imageID 证明身份。

## 待确认事项

无。授权、目标环境、回滚边界和真实数据范围均已明确；实时状态由预检冻结。

## 需求覆盖检查

| 需求 | 验收标准 | 计划用例 |
| --- | --- | --- |
| REQ-001 | AC-001 | TC-011 生产预检 |
| REQ-002、REQ-003 | AC-002、AC-003 | TC-011 Worker rollout 与稳定窗口 |
| REQ-004 | AC-004 | TC-011 第一次 Inoreader 运行 |
| REQ-005 | AC-005 | TC-011 第二次 Inoreader 运行 |
| REQ-006 | AC-006 | 失败时精确镜像回滚 |
| REQ-007 | AC-007 | OpenSpec、验收、GitNexus 与 Git 交付门禁 |

所有 P0 需求均有可判定 AC；无未解决阻塞项。
