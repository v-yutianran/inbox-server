## ADDED Requirements

### Requirement: 受鉴权保护的运维汇总
系统 SHALL 提供受 `X-API-Key` 保护的运维汇总接口，返回 server 状态、worker 心跳、调度间隔与下次运行时间、脱敏渠道、link/text/file/article 队列统计以及最近同步和文章归档事件；响应 MUST NOT 包含凭据、API Key、Cookie 或文章正文。

#### Scenario: 使用有效 API Key 获取汇总
- **WHEN** 客户端使用有效 `X-API-Key` 请求运维汇总
- **THEN** 系统返回当前调度、worker、渠道、队列和最近历史的结构化数据

#### Scenario: 未鉴权访问运维汇总
- **WHEN** 系统已配置管理 API Key 且客户端未提供或提供错误 Key
- **THEN** 系统返回 401 且不返回任何运维数据

### Requirement: 同步运行历史持久化
系统 SHALL 将手动和定时同步的触发来源、状态、脱敏汇总、开始时间、完成时间及安全错误类型持久化到 PostgreSQL；记录系统短暂失败 MUST NOT 阻止主同步流程。

#### Scenario: 手动同步成功
- **WHEN** 用户通过现有 `/sync` 成功触发一次同步
- **THEN** 系统保留一条 `manual` 运行记录并标记为完成

#### Scenario: 定时同步失败
- **WHEN** 定时采集抛出异常
- **THEN** 系统尽力保留一条 `scheduler` 失败记录且调度器后续运行不受影响

### Requirement: 文章归档终态历史
系统 SHALL 持久化文章归档的 committed、exists、skipped 和 failed 终态，包括原始 URL、标题、文件名、原因和发生时间；事件写入失败 MUST NOT 反转文章归档结果。

#### Scenario: 文章成功归档并推送
- **WHEN** 文章 Markdown 成功写入 Git 仓库并完成 push
- **THEN** 系统记录 committed 事件及文件名

#### Scenario: 页面不是有效长文
- **WHEN** 直接抓取和浏览器兜底后正文仍不满足验收条件
- **THEN** 系统记录 skipped 事件及安全原因且不生成 Markdown

### Requirement: worker TTL 心跳
worker MUST 定期写入带过期时间的 Redis 心跳；运维接口 SHALL 仅在心跳未过期时报告 worker 在线，并返回最后心跳时间。

#### Scenario: worker 正常运行
- **WHEN** worker 按周期刷新心跳且心跳未过期
- **THEN** 运维汇总报告 worker 在线并显示最近心跳时间

#### Scenario: worker 停止刷新心跳
- **WHEN** 心跳键已过期
- **THEN** 运维汇总报告 worker 离线或未知

### Requirement: 组件化单页控制台
系统 SHALL 在根路径提供 React + TypeScript 单页控制台，以组件化方式展示状态卡片、渠道、队列、同步历史和文章历史，并在手机与桌面视口保持可读和可操作。

#### Scenario: 首次打开控制台
- **WHEN** 浏览器当前会话没有管理 API Key
- **THEN** 页面显示解锁界面且不请求受保护数据

#### Scenario: 解锁后加载控制台
- **WHEN** 用户输入有效 API Key
- **THEN** 页面将 Key 仅保存到 `sessionStorage`，加载运维汇总并展示手动刷新和手动同步入口

#### Scenario: API 请求失败
- **WHEN** 运维汇总请求失败或返回非成功状态
- **THEN** 页面显示可操作的错误状态且保留重试入口

### Requirement: 手动同步保持现有契约
控制台 SHALL 通过现有 `POST /sync` 触发手动同步，并在完成后刷新运维汇总；系统 MUST 保持现有 `/sync` 成功响应结构和通知行为。

#### Scenario: 从控制台触发同步
- **WHEN** 已解锁用户点击手动同步且请求成功
- **THEN** 页面反馈完成并刷新队列和运行历史

### Requirement: 同源静态交付
生产镜像 MUST 在构建阶段生成前端静态资源，并由 Nginx 在唯一宿主机端口提供根页面和静态资源、反向代理 FastAPI；FastAPI MUST NOT 直接暴露宿主机端口，代理规则 MUST NOT 遮蔽现有 API、OpenAPI 或健康检查路径。

#### Scenario: 部署后访问根页面和 API
- **WHEN** Nginx、FastAPI 新镜像启动且数据库迁移完成
- **THEN** `/` 返回控制台，`/assets/*` 返回静态资源，既有 API 路径继续按原契约响应
