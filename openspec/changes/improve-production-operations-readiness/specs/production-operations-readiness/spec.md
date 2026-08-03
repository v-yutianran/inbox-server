## ADDED Requirements

### Requirement: 分层健康状态
系统 SHALL 分别报告 Console、Cloudflare API、Sealos Worker、浏览器运行时、Mihomo 和 WARP 的存活、就绪与降级状态，Worker 健康响应 MUST 不依赖正在执行的浏览器任务完成。

#### Scenario: 浏览器任务阻塞但健康服务仍可响应
- **WHEN** Worker 正在执行长耗时浏览器提取且主工作循环暂时繁忙
- **THEN** 健康端点仍在探针超时预算内响应，并准确区分存活、就绪和降级状态

#### Scenario: 出站代理尚未就绪
- **WHEN** WARP 或 Mihomo 未达到可用状态
- **THEN** Worker 报告不可处理依赖代理的任务，且不领取会立即失败的任务

### Requirement: 可度量的服务目标
系统 SHALL 为 API 可用性、Worker 心跳新鲜度、可执行任务积压时长、任务处理结果和文章提取路径定义可计算的 SLI、SLO 与告警阈值。

#### Scenario: SLO 越界触发告警
- **WHEN** 任一 SLI 在规定窗口内越过 SLO 或错误预算阈值
- **THEN** 系统产生不含敏感信息的告警，并附带服务、部署版本、时间窗口和关联标识

#### Scenario: 运维人员查看趋势
- **WHEN** 运维人员打开控制台或查询运维 API
- **THEN** 系统返回当前值、窗口趋势、阈值和数据采集时间，而不是仅返回单次状态快照

### Requirement: 稳定且安全的运行事件
生产关键路径 MUST 记录符合 `<领域>.<动作>.<结果>` 的稳定事件，并使用 `jobId`、`leaseId`、`itemKind`、来源、目标和部署版本建立关联；日志与遥测 MUST NOT 包含 API Key、Cookie、浏览器登录态、文章正文或其它敏感值。

#### Scenario: 任务从领取到结算可追踪
- **WHEN** Worker 领取、续租、处理并结算一个任务
- **THEN** 所有阶段可通过稳定关联标识串联，且能够识别成功、延迟、重试与死信分支

### Requirement: 积压与死信生命周期
系统 SHALL 按状态、任务类型、失败原因、年龄和部署版本统计积压、延迟任务与 DLQ，并 MUST 提供带 dry-run、逐条审核、幂等校验和审计记录的重放与清理流程。

#### Scenario: DLQ 数量与 dead job 不一致
- **WHEN** DLQ 记录数与 dead job 数量存在差异
- **THEN** 系统输出可解释的差异分类，包括历史迁移、孤立记录、已重放记录或数据完整性异常，且不自动删除记录

#### Scenario: 安全重放死信
- **WHEN** 运维人员选择一条可重放 DLQ 并先执行 dry-run
- **THEN** 系统验证 envelope、幂等键、目标副作用和当前限速，只有显式执行后才重新发布并记录审计结果

#### Scenario: 数据达到保留期限
- **WHEN** 运行记录超过已批准的保留期限
- **THEN** 清理任务仅删除符合状态和期限条件的记录，并输出删除数量、范围和验证结果

### Requirement: 可重复发布与回滚
Cloudflare API、Console 与 Sealos Worker 的发布 SHALL 支持相同参数的 dry-run 和实际执行，MUST 固定源码提交、Cloudflare 版本与容器 digest，并在变更前后保存可验证且不含敏感信息的证据。

#### Scenario: 发布前预检失败
- **WHEN** migration、镜像 digest、Secret 引用、探针、备份或线上 canary 任一门禁失败
- **THEN** 发布停止且不修改线上版本

#### Scenario: 执行回滚
- **WHEN** 新版本违反健康、错误率或积压退出门槛
- **THEN** 系统能恢复到上一 Cloudflare 版本和 Worker digest，并验证 D1 数据仍兼容且关键流程恢复

### Requirement: 隔离的线上 canary
系统 SHALL 提供不写入真实外部目标、不使用真实用户数据的线上 canary，覆盖 API 入队、Worker 领取、直接文章提取、浏览器回退、归档模拟和结算路径。

#### Scenario: 浏览器回退 canary
- **WHEN** canary 输入被直接提取路径按预期拒绝
- **THEN** Worker 执行浏览器回退并产生成功结算证据，且不向 Cubox、Flomo、坚果云或真实文章仓库写入数据

### Requirement: 容量与高可用准入
系统 SHALL 持续记录 Worker CPU、内存、重启、任务耗时、队列到达率和消化率；在启用多副本前 MUST 验证租约、幂等、副作用隔离、浏览器状态和归档写入的并发安全。

#### Scenario: 单副本容量接近上限
- **WHEN** 积压增长率、资源利用率或任务时长持续越过容量阈值
- **THEN** 系统告警并给出限流、扩容或降级依据，而不是直接启动未经验证的第二副本

#### Scenario: 申请启用多副本
- **WHEN** 计划把 Worker 副本数从一提升到多
- **THEN** 必须先通过并发租约、重复投递、文章归档冲突、浏览器登录态和故障转移验收，并记录独立 ADR

### Requirement: 配置与凭据边界
API 和 Worker MUST 在启动时校验必需配置，并 SHALL 只从 Cloudflare Secret、Sealos Secret 或受控文件挂载读取敏感值；Console 管理凭据不得进入构建产物、日志或长期浏览器存储。

#### Scenario: 必需 Secret 缺失
- **WHEN** 生产实例启动时缺少或误配必需 Secret
- **THEN** 实例快速失败并输出已脱敏的配置项名称，不进入部分可用状态

