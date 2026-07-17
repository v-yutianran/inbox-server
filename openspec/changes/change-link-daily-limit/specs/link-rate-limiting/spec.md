## ADDED Requirements

### Requirement: link 每日处理上限
系统 SHALL 按 `Asia/Shanghai` 自然日限制 link 队列每天最多成功处理 500 条。

#### Scenario: 未达到每日上限
- **WHEN** 当日已成功处理的 link 数量小于 500
- **THEN** worker 继续按现有消费间隔处理 link 队列

#### Scenario: 达到每日上限
- **WHEN** 当日已成功处理的 link 数量达到 500
- **THEN** worker MUST 停止从 link 队列取出新项目，直至下一个上海自然日

### Requirement: link 不使用固定窗口限速
系统 MUST 不对 link 队列应用 6 小时或其他固定窗口数量限制。

#### Scenario: 旧固定窗口计数已满
- **WHEN** link 的历史固定窗口 Redis key 已达到旧上限
- **THEN** worker 仍根据每日上限决定是否处理 link，不得因该固定窗口计数阻塞

### Requirement: 其他队列限速保持不变
系统 MUST 保持 text、file 和 article 队列现有固定窗口及日限额行为。

#### Scenario: 非 link 队列消费
- **WHEN** worker 消费 text、file 或 article 队列
- **THEN** 系统继续应用该队列配置的固定窗口限速

### Requirement: 切换当天继承计数
系统 MUST 在从 UTC 日计数切换到上海自然日计数时继承已有 link 日计数，以避免切换当天放大配额。

#### Scenario: 上海日 key 尚不存在
- **WHEN** 部署时旧 UTC 日 key 已有计数且当前上海日 key 不存在
- **THEN** 系统将旧计数写入当前上海日 key 后再启动 worker

#### Scenario: 上海日 key 已存在
- **WHEN** 部署时旧 UTC 日 key和当前上海日 key均有计数
- **THEN** 系统将两者相加作为当前上海日计数，并且该迁移 MUST 仅执行一次
