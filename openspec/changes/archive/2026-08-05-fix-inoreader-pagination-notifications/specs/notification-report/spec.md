## MODIFIED Requirements

### Requirement: 有新内容时通过双通道发送同步报告
系统 SHALL 在 collect_job 汇总后，当 enqueued 总数 > 0 时，通过已配置的通知通道（Telegram + Email）发送同步报告；总数为 0 时 SHALL 不发送。报告 MUST 将 enqueued 数量表述为“已入队”，MUST NOT 将其表述为外部目标最终发布或保存成功。

#### Scenario: 有新内容触发双通道
- **WHEN** collect_job 汇总 enqueued 总数 > 0，且 Telegram 与 Email 通道均已配置
- **THEN** 系统同时向 Telegram（sendMessage）和 QQ 邮箱（SMTP）发送汇总报告，并把 enqueued 数量显示为“已入队”

#### Scenario: 无新内容不发送
- **WHEN** collect_job 汇总 enqueued 总数 == 0
- **THEN** 系统不发送任何通知

#### Scenario: 入队不冒充最终交付
- **WHEN** collect_job 已创建 dispatch jobs 但尚未取得外部目标最终结果
- **THEN** 通知 MUST NOT 使用“发布成功”或“保存成功”描述该数量
