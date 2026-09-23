# notification-report Specification

## Purpose
TBD - created by archiving change fix-parity-gaps. Update Purpose after archive.
## Requirements
### Requirement: 有新内容时通过双通道发送同步报告
系统 SHALL 在 collect_job 汇总后，当 enqueued 总数 > 0 时，通过已配置且启用的通知通道（Telegram + Email）发送同步报告；总数为 0 时 SHALL 不发送。报告 MUST 将 enqueued 数量表述为“已入队”，MUST NOT 将其表述为外部目标最终发布或保存成功。

#### Scenario: 有新内容触发双通道
- **WHEN** collect_job 汇总 enqueued 总数 > 0，且 Telegram 与 Email 通道均已配置并启用
- **THEN** 系统同时向 Telegram（sendMessage）和 SMTP 发送汇总报告，并把 enqueued 数量显示为“已入队”

#### Scenario: Sealos Worker 显式关闭邮件
- **WHEN** collect_job 汇总 enqueued 总数 > 0，SMTP 凭据齐全，且 `EMAIL_NOTIFICATIONS_ENABLED` 为 `false`
- **THEN** 系统只向已配置的 Telegram 通道发送汇总报告，不建立 SMTP 连接

#### Scenario: 无新内容不发送
- **WHEN** collect_job 汇总 enqueued 总数 == 0
- **THEN** 系统不发送任何通知

#### Scenario: 入队不冒充最终交付
- **WHEN** collect_job 已创建 dispatch jobs 但尚未取得外部目标最终结果
- **THEN** 通知 MUST NOT 使用“发布成功”或“保存成功”描述该数量

### Requirement: 通知通道配置驱动且失败不阻塞
系统 SHALL 由配置决定启用哪些通道；邮件开关关闭时 MUST 跳过 SMTP，即使 SMTP 凭据齐全；任一已启用通道未配置或发送失败时 MUST 不影响其他已启用通道与主同步流程。

#### Scenario: Telegram chat_id 未配置
- **WHEN** notification 段未配 telegram_chat_id
- **THEN** 系统跳过 Telegram 通道，不抛错，Email 通道（若已启用且配置）仍发

#### Scenario: Email SMTP 未配置
- **WHEN** smtp 凭据缺失
- **THEN** 系统跳过 Email 通道，不抛错，Telegram 通道（若已配置）仍发

#### Scenario: Telegram 发送失败且邮件关闭
- **WHEN** `EMAIL_NOTIFICATIONS_ENABLED` 为 `false`，且 Telegram 发送失败
- **THEN** 系统记录 Telegram 发送失败并继续主同步流程，不尝试 SMTP

### Requirement: Worker 邮件通知开关接受明确布尔值
TypeScript Worker SHALL 将 `EMAIL_NOTIFICATIONS_ENABLED` 解析为邮件通知开关；未设置时 MUST 默认为 `true`，并 MUST 只接受字符串 `true` 或 `false`。其他值 MUST 阻止 Worker 启动。

#### Scenario: 未设置开关时保留邮件通知
- **WHEN** Worker 环境未设置 `EMAIL_NOTIFICATIONS_ENABLED`
- **THEN** Worker 将邮件通知解析为启用

#### Scenario: 开关显式关闭邮件
- **WHEN** Worker 环境将 `EMAIL_NOTIFICATIONS_ENABLED` 设置为 `false`
- **THEN** Worker 成功启动并跳过邮件发送

#### Scenario: 开关值无效
- **WHEN** Worker 环境将 `EMAIL_NOTIFICATIONS_ENABLED` 设置为除 `true` 或 `false` 之外的值
- **THEN** Worker 配置解析失败并拒绝启动

### Requirement: Email 通道用 SMTP 直连
系统 SHALL 用 Python stdlib（smtplib）直连 QQ SMTP 发送邮件，MUST NOT 依赖 agently-cli 或 node 运行时。

#### Scenario: SMTP 配置齐全发送邮件
- **WHEN** smtp_host/smtp_user/smtp_pass 齐全且 enqueued > 0
- **THEN** 系统经 SMTP 发送同步报告邮件，整个过程不调用 node 或 agently-cli
