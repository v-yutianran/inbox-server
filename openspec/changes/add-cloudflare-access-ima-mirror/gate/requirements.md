# Cloudflare Access 与 ima 镜像需求设计

## 文档信息

- 名称：Cloudflare Access 与 ima 文章镜像
- 状态：已确认，待实施
- 版本：1.0
- 适用范围：Console、Cloudflare Access、Sealos Worker 文章归档
- 关联资料：`../proposal.md`、`../specs/**/*.md`

## 背景与问题

Console 当前只有共享 API Key 解锁，缺少人的身份层；Git 文章归档完成后也无法进入用户的 ima 检索空间。实时检查确认 Cloudflare 已配置 Google 与 One-time PIN IdP，ima 官方契约支持 Markdown 文件导入。

## 目标与成功指标

- 未登录访问 Console 时 100% 由 Access 拦截，Google 与邮箱验证码均可用。
- Access 登录后现有 API Key 授权测试零回归。
- 启用 ima 后，合成 Markdown 可成功导入；重投不重复上传；禁用时零 ima 请求。
- 自动测试、typecheck、build、OpenSpec 和秘密扫描全部通过。

## 非目标

- 不建立多租户账户或角色系统。
- 不替换 `X-API-Key`，不反向同步 ima，不迁移历史文章。

## 用户与场景

- 运维用户：通过 Google 或邮箱验证码进入 Console，再输入管理 Key。
- Worker：Git 成功后镜像 Markdown；外部失败按文章任务重试，Git 结果保持不变。

## 范围

- 包含：Console 锁定态 UI、Access 配置契约、ima 适配器、Sealos Secret 引用、测试与文档。
- 排除：历史回填、ima 内容删除、真实联系人自动化。
- 依赖：Cloudflare Access IdP、ima OpenAPI/COS、Sealos Secret。

## 需求清单

| ID | 优先级 | 需求陈述 | 来源 |
|---|---|---|---|
| REQ-001 | P0 | Console 必须支持 Google 与邮箱验证码身份登录 | 用户选择方案 2 |
| REQ-002 | P0 | Access 登录后仍必须使用管理 API Key | 现有安全边界 |
| REQ-003 | P1 | 登录与解锁体验必须清晰、响应式且可访问 | 用户 UI 诉求 |
| REQ-004 | P0 | Git 成功后可选镜像同一 Markdown 到指定 ima 库 | 用户 ima 诉求 |
| REQ-005 | P0 | ima 失败不得撤销 Git，必须幂等重试且不泄密 | 归档不变量 |

## 业务规则与状态

- Access 身份已认证不等于管理操作已授权。
- Git 是权威状态；ima 是 `disabled → pending → succeeded/failed` 的可选镜像。
- 只有 `Git=succeeded` 才允许进入 `ima=pending`；完成标记存在时不得再次上传。

## 非功能需求

- 网络请求必须有界超时；日志仅使用低基数阶段和原因码。
- 不记录凭据、邮箱、文章内容、完整 URL、文件名、knowledge ID 或响应 body。
- 登录页覆盖 WCAG 2.2 A/AA 中适用的键盘、焦点、名称、错误、重排和缩放要求。

## 验收标准

- AC-001：Given 匿名用户，When 访问 Console，Then 被 Access 拦截且可选 Google/邮箱验证码。
- AC-002：Given Access 已登录但无 Key，When 打开 Console，Then 只显示解锁页且不请求管理数据。
- AC-003：Given Git 归档成功且 ima 启用，When 镜像，Then 完成上传、导入和原子完成标记。
- AC-004：Given ima 失败，When 任务重试，Then 复用 Git 文件且不生成第二份 Git 文章。
- AC-005：Given ima 禁用，When 文章归档成功，Then 零 ima/COS 请求。

## 风险、假设与待确认事项

- 已暴露的 ima Key 必须在生产验证前轮换；无其它阻塞实现的待确认项。

## 需求覆盖检查

| 目标 | 需求 | 验收 |
|---|---|---|
| 身份与授权分层 | REQ-001、REQ-002、REQ-003 | AC-001、AC-002 |
| Git 后 ima 镜像 | REQ-004、REQ-005 | AC-003、AC-004、AC-005 |
