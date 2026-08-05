## Why

link 队列当前同时受 6 小时固定窗口和每日配额限制，固定窗口会在下游仍可正常接收时造成大量积压。需要将 link 队列收敛为按上海自然日控制的单一日限额，以提高吞吐并保持明确的每日上限。

## What Changes

- 将 link 队列每日最多处理数量从 480 调整为 500。
- 取消 link 队列的 6 小时固定窗口限制，保留现有消费间隔。
- 明确每日计数按 `Asia/Shanghai` 自然日计算，并在切换当天继承旧 UTC 日计数。
- text、file 和 article 队列的既有限速策略保持不变。

## Capabilities

### New Capabilities

- `link-rate-limiting`: 定义 link 队列仅受上海自然日 500 条上限约束的行为，以及切换当天的计数迁移要求。

### Modified Capabilities

无。

## Impact

- 影响 `src/inboxserver/workers/consumer.py` 的固定窗口判断和 `src/inboxserver/workers/runner.py` 的 link 限速配置。
- 影响 `docker-compose.yml` 中 server、worker 的业务时区配置。
- 部署时需要迁移 Redis 中当日 link 计数并强制重建 server、worker 容器。
- 不改变 API、数据库结构、生产依赖或其他队列限速策略。
