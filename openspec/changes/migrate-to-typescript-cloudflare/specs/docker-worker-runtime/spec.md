## ADDED Requirements

### Requirement: Headed Playwright 运行时
Docker worker MUST 在 Xvfb 提供的显示环境中以 `headless: false` 启动 Playwright Chromium，并 SHALL 在缺少可用显示环境时拒绝进入 ready 状态。

#### Scenario: 显示环境可用
- **WHEN** 容器启动 Xvfb 且 Chromium 可以连接指定 DISPLAY
- **THEN** worker 完成浏览器自检并进入 ready 状态

#### Scenario: 显示环境不可用
- **WHEN** Xvfb 未启动或 Chromium 无法连接 DISPLAY
- **THEN** readiness 探针失败且 worker 不领取新的 browser 任务

### Requirement: Pull consumer 租约处理
worker SHALL 使用 Cloudflare Queues HTTP pull consumer 批量领取任务，并 MUST 只在业务副作用和幂等状态均持久化成功后确认消息。

#### Scenario: 任务成功
- **WHEN** worker 在租约内完成任务并持久化成功状态
- **THEN** worker 确认对应消息且后续重复消息不会再次产生业务副作用

#### Scenario: 可重试失败
- **WHEN** 任务遇到临时网络错误或可恢复平台错误
- **THEN** worker 不确认消息并按队列重试策略释放或延长租约

#### Scenario: 不可重试失败
- **WHEN** 消息 schema 不受支持或业务输入永久无效
- **THEN** worker 记录不含敏感 payload 的失败原因并将消息交由死信流程处理

### Requirement: 持久化登录态与归档状态
worker MUST 将浏览器登录态、文章 Git 工作区及其它跨重启长期状态放入加密数据库或 Sealos 持久卷，不得仅保存在容器可写层。

#### Scenario: Pod 重建后恢复登录态
- **WHEN** worker Pod 被重建并重新挂载原持久卷与密钥
- **THEN** worker 可以恢复已授权平台的登录态而无需依赖旧容器文件系统

#### Scenario: 日志保护敏感数据
- **WHEN** 登录态解密、任务解析或平台请求失败
- **THEN** 结构化日志不包含 Cookie、token、完整队列 payload 或解密后的凭据

### Requirement: 健康检查与优雅退出
worker SHALL 提供 liveness 与 readiness 信号，并 MUST 在收到 SIGTERM 后停止领取新任务、在终止宽限期内收尾或安全释放租约、关闭浏览器并退出。

#### Scenario: 事件循环停滞
- **WHEN** 队列轮询或主事件循环超过健康阈值未推进
- **THEN** liveness 探针失败并允许编排器重启容器

#### Scenario: 收到终止信号
- **WHEN** PID 1 Node 进程收到 SIGTERM
- **THEN** worker 停止拉取新消息并在关闭浏览器和处理当前租约后退出

### Requirement: 单副本安全基线
在 collector 分布式锁和所有 destination 幂等契约验证通过前，Sealos worker Deployment MUST 保持单副本。

#### Scenario: 初始部署
- **WHEN** 生成或应用迁移阶段的 Sealos 模板
- **THEN** worker 副本数为 1，且没有创建重复调度来源

### Requirement: 私有 Sealos 部署
worker SHALL 部署到 `sealos.run` 北京区 `bja`、工作区 `ns-tbs948af`，MUST 使用固定版本镜像、持久卷、Secret、资源限制和探针，且不得创建公网 Ingress。

#### Scenario: 模板静态验证
- **WHEN** 对 Sealos 模板执行校验
- **THEN** 模板只暴露 Pod 内健康端口，镜像无浮动标签，敏感配置来自 Secret，长期文件来自持久卷

#### Scenario: Chromium 资源验收
- **WHEN** 以候选资源档完成冷启动、轻量页面、真实页面、一次交互和 60 秒稳定窗口
- **THEN** 最终资源档是无 OOM、无重启、无探针抖动和资源超时的最低 Sealos 阶梯值

### Requirement: Browser source 功能对等
每个 browser source 迁入 TypeScript worker 前 MUST 使用相同凭据、基线和去重键验证解析结果，并 SHALL 保留现有首次采集防重复行为。

#### Scenario: 迁移单个 browser source
- **WHEN** 新旧 worker 对同一稳定页面在禁用外部分发的 shadow 模式采集
- **THEN** 新 worker 的规范化条目、来源键、去重键和错误分类满足现有对应规范

#### Scenario: 首次启用已有账号
- **WHEN** 已有账号首次切换到新 worker
- **THEN** 系统先导入或建立基线，再允许增量任务产生外部分发

### Requirement: 受控出站代理
Sealos worker MUST 使用固定版本的官方 Cloudflare WARP sidecar 提供受控出站网络，SHALL 以非 root 且无额外 Linux capability 的本地代理模式运行，并 MUST 将注册状态保存到独立持久卷。经验证与 WARP CONNECT 不兼容的 Git smart-HTTP pack 操作 MUST 仅在 Git 子进程内清空代理环境后通过 HTTPS 直连仓库，其他 Node HTTP 与 headed Chromium 流量 MUST 继续经过 WARP。

#### Scenario: 代理就绪
- **WHEN** WARP 已连接、DoH 解析可用且经代理访问 Cloudflare trace 返回 `warp=on`
- **THEN** worker 可以进入 ready 并通过 Pod loopback 代理访问配置的外部来源与目标

#### Scenario: 代理未就绪
- **WHEN** WARP 注册、隧道、DoH 或 CONNECT 适配器任一环节不可用
- **THEN** worker 不进入 ready、不领取新任务，并输出不含代理凭据或注册材料的结构化错误

#### Scenario: Pod 重建
- **WHEN** WARP sidecar 被重建并重新挂载原持久卷
- **THEN** sidecar 复用已有注册状态恢复连接，不依赖本机 Docker、ClashX 配置或容器可写层

#### Scenario: Git pack 分流
- **WHEN** 文章归档执行仓库浅克隆、拉取或推送
- **THEN** 只有 Git 子进程绕过 WARP 直连 GitHub，正文抓取与浏览器流量仍通过返回 `warp=on` 的 Pod loopback 代理
