## ADDED Requirements

### Requirement: 有新内容时通过双通道发送同步报告
系统 SHALL 在 collect_job 汇总后，当 enqueued 总数 > 0 时，通过已配置的通知通道（Telegram + Email）发送同步报告；总数为 0 时 SHALL 不发送。

#### Scenario: 有新内容触发双通道
- **WHEN** collect_job 汇总 enqueued 总数 > 0，且 Telegram 与 Email 通道均已配置
- **THEN** 系统同时向 Telegram（sendMessage）和 QQ 邮箱（SMTP）发送汇总报告

#### Scenario: 无新内容不发送
- **WHEN** collect_job 汇总 enqueued 总数 == 0
- **THEN** 系统不发送任何通知

### Requirement: 通知通道配置驱动且失败不阻塞
系统 SHALL 由配置决定启用哪些通道；任一通道未配置或发送失败时 MUST 不影响其他通道与主同步流程。

#### Scenario: Telegram chat_id 未配置
- **WHEN** notification 段未配 telegram_chat_id
- **THEN** 系统跳过 Telegram 通道，不抛错，Email 通道（若配）仍发

#### Scenario: Email SMTP 未配置
- **WHEN** smtp 凭据缺失
- **THEN** 系统跳过 Email 通道，不抛错，Telegram 通道（若配）仍发

### Requirement: Email 通道用 SMTP 直连
系统 SHALL 用 Python stdlib（smtplib）直连 QQ SMTP 发送邮件，MUST NOT 依赖 agently-cli 或 node 运行时。

#### Scenario: SMTP 配置齐全发送邮件
- **WHEN** smtp_host/smtp_user/smtp_pass 齐全且 enqueued > 0
- **THEN** 系统经 SMTP 发送同步报告邮件，整个过程不调用 node 或 agently-cli
