## Purpose

为运维 Console 提供基于 Cloudflare Access 的个人身份登录与一致、可访问的登录体验，同时保留管理 API 的独立授权边界。

## ADDED Requirements

### Requirement: Console 必须经过 Cloudflare Access 身份登录
系统 SHALL 在公开 Console 静态页面之前执行 Cloudflare Access 身份认证，并 MUST 同时提供 Google 与邮箱一次性验证码两种登录方式。

#### Scenario: 使用 Google 登录
- **WHEN** 未登录用户访问受保护的 Console 地址并选择 Google
- **THEN** 系统 SHALL 完成 Google 身份认证后返回原 Console 地址

#### Scenario: 使用邮箱验证码登录
- **WHEN** 未登录用户访问受保护的 Console 地址并选择邮箱一次性验证码
- **THEN** 系统 SHALL 在验证码验证成功后返回原 Console 地址

#### Scenario: 身份认证失败
- **WHEN** 身份提供商拒绝、验证码失效或 Access 策略不允许当前身份
- **THEN** 系统 MUST NOT 返回 Console 内容，并 SHALL 提供可恢复的登录反馈

### Requirement: 身份认证与管理授权保持双层边界
系统 SHALL 仅把 Cloudflare Access 作为人的身份认证层，并 MUST 继续要求现有管理 API Key 才能调用受保护的管理 API。

#### Scenario: 已登录但没有管理 API Key
- **WHEN** 用户已通过 Cloudflare Access 但当前浏览器会话没有管理 API Key
- **THEN** Console SHALL 显示 API Key 解锁页，且 MUST NOT 发起受保护的管理请求

#### Scenario: 已登录且 API Key 有效
- **WHEN** 用户通过 Access 且提供有效管理 API Key
- **THEN** Console SHALL 仅在当前会话保存该 Key 并加载运维数据

### Requirement: 登录体验必须清晰且可访问
Console 登录与解锁界面 SHALL 使用克制的单主操作视觉层级，并 MUST 覆盖持久标签、键盘操作、可见焦点、错误通知、窄屏重排和 200% 缩放下的可用性。

#### Scenario: 键盘完成 API Key 解锁
- **WHEN** 用户只使用键盘输入 API Key 并提交
- **THEN** 焦点顺序 SHALL 符合视觉顺序，提交控件 SHALL 可触发，错误 SHALL 通过可访问 alert 呈现

#### Scenario: 窄屏与放大显示
- **WHEN** 视口缩小到移动端宽度或页面缩放至 200%
- **THEN** 登录内容 SHALL 保持可读、无水平溢出且主操作仍可见
