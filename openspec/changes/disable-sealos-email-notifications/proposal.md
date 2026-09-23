# Proposal

## Why

Sealos Worker 当前在 SMTP 凭据齐全时会发送邮件，但运行通知只需要 Telegram。需要提供明确的邮件关闭开关，并让 Sealos Worker 默认只尝试 Telegram，同时保留其他环境现有的双通道默认行为。

## What Changes

- 新增 `EMAIL_NOTIFICATIONS_ENABLED` 配置，默认 `true`，只接受 `true` 或 `false`。
- 配置为 `false` 时跳过 SMTP；Telegram 独立发送，失败不触发邮件回退。
- 在当前 Sealos Worker 清单中显式设置该配置为 `false`，保留 SMTP 能力供默认开启的其他环境使用。
- 更新 Worker 运维手册，说明开关默认值与旧镜像回滚风险。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `notification-report`：增加邮件通道显式关闭及 Telegram 独立发送的行为契约。

## Impact

影响 TypeScript Worker 的环境配置、通知器及其测试、Sealos Worker 清单与运维手册；不新增依赖，不删除 SMTP 实现。
