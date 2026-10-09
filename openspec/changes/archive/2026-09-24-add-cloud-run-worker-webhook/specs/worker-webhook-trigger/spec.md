## Purpose

为 Cloud Run Service 按需执行提供经认证的 worker 唤醒入口，将队列批次领取、业务执行和结算绑定到同一次 HTTP 请求，明确并发、重试及部署前提，避免实例缩到零后依赖容器内轮询。

## ADDED Requirements

### Requirement: 经认证的唤醒入口
webhook 模式 MUST 提供 POST /webhooks/worker，使用独立 Bearer 凭据认证，且 SHALL 不把请求正文当作业务任务来源。

#### Scenario: 未授权调用
- **WHEN** 请求缺失或携带错误凭据
- **THEN** 返回 401 且不领取或处理任务

#### Scenario: 方法错误
- **WHEN** 请求对 webhook 使用非 POST 方法
- **THEN** 返回 405 且不处理任务

### Requirement: 请求内完成有界批次
每次合法唤醒 MUST 在请求预算内串行领取和结算已到期批次，直至一次领取返回空批次；只有已确认无到期消息时 SHALL 返回 200。预算耗尽而尚未确认排空或依赖异常 MUST 返回无秘密、可重试的 503，且 SHALL 复用现有控制面的租约和业务幂等状态，不得在响应后继续处理任务。

#### Scenario: 连续批次与空队列
- **WHEN** 收件箱中有多批已到期消息
- **THEN** 系统串行结算各批，直到一次领取为空后返回 200，未完成结算时请求保持未完成

#### Scenario: 请求预算耗尽
- **WHEN** 已完成部分批次但预算不足以安全领取下一批，且尚未确认无到期消息
- **THEN** 返回 503 与重试提示，已完成的批次保持幂等终态，后续唤醒继续处理剩余消息

#### Scenario: 失败后重试
- **WHEN** 领取或结算发生异常
- **THEN** 返回可重试的 503，不伪造业务完成，不回显底层错误正文

### Requirement: 串行接收与停机拒绝
同一进程 MUST 串行执行 webhook 批次；繁忙、尚未就绪或停止中的实例 MUST 拒绝新触发并提示稍后重试；跨实例安全 SHALL 依赖既有控制面租约，不依赖单进程锁。

#### Scenario: 重叠调用
- **WHEN** 前一个批次未完成又收到合法唤醒
- **THEN** 后一个返回 503 与 Retry-After，且没有第二次领取

### Requirement: 显式运行模式与端口
默认 SHALL 保留 loop 模式；webhook 模式 MUST 要求独立凭据和启用业务处理，并 SHALL 使用 Cloud Run PORT；webhook 模式无请求时 MUST 不轮询队列或运行周期心跳。

#### Scenario: 配置不完整
- **WHEN** webhook 模式缺少触发凭据或未启用业务处理
- **THEN** 启动配置验证失败

#### Scenario: 等待请求
- **WHEN** webhook 模式已经启动且没有请求
- **THEN** HTTP 接口可接受唤醒，队列 pull 和周期 heartbeat 不被调用

### Requirement: 安全可观测性
入口 SHALL 使用固定事件名记录请求完成或拒绝，MUST 不记录 Authorization、正文、完整 URL 或底层异常消息。

#### Scenario: 敏感依赖错误
- **WHEN** 依赖抛出包含 token 的错误
- **THEN** HTTP 响应和入口日志均不含该 token

### Requirement: 队列持久化后唤醒与周期补偿
启用云端唤醒时，API Queue consumer MUST 在持久化消息后向 worker webhook 发送认证请求，且 MUST 仅在唤醒成功后确认原 Queue 消息；失败时 SHALL 允许 Queue 重投并依赖稳定消息 ID 去重。现有 Cron SHALL 周期唤醒，以覆盖重试延期和积压，不得仅依赖新的 Queue 投递。

#### Scenario: 持久化失败
- **WHEN** Queue 消息无法写入持久收件箱
- **THEN** 系统不调用 webhook，也不确认原 Queue 消息

#### Scenario: 唤醒失败
- **WHEN** 收件箱已写入，但 webhook 网络调用失败或返回非成功状态
- **THEN** 系统不确认原 Queue 消息；重投不得产生第二份持久消息

#### Scenario: 延期积压
- **WHEN** 没有新的 Queue 消息，收件箱中仍有延期后可领取的任务
- **THEN** 周期触发再次唤醒 worker

#### Scenario: 新批次暂存时已有旧批次
- **WHEN** 新 Queue 批次已暂存，而 webhook 首先领取了旧批次
- **THEN** 当前唤醒不得仅凭旧批次结算成功就报告已排空；须继续领取到空或返回可重试状态
