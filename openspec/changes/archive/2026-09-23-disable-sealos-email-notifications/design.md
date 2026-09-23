# Design

## Context

动机见 [proposal.md](./proposal.md#why)。TypeScript Worker 当前将环境配置与通知通道凭据分开解析；通知器在 SMTP 凭据齐全时会加入邮件发送任务。Sealos 清单提供 Worker 运行配置，通道凭据继续由现有 Secret 提供。

## Goals / Non-Goals

**Goals:**

- 在通知器创建 SMTP 发送任务前应用显式运行开关。
- 未设置开关的环境继续使用当前默认行为。
- 在 Sealos 清单中显式关闭邮件，Telegram 配置保持独立。
- 在 Worker 运维手册中记录开关与旧镜像回滚风险。

**Non-Goals:**

- 删除 SMTP 能力或改变现有通道凭据格式。
- 修改通知内容、重试策略或 Python 兼容实现。
- 修改数据库 schema 或增加数据迁移。

## Decisions

1. 在现有 Worker 配置 schema 中解析 `EMAIL_NOTIFICATIONS_ENABLED`，仅接受字符串 `true` 与 `false`，默认值为 `true`。无效值使启动失败，避免静默选择通道状态。
2. 将解析后的布尔值传入现有通知编排，只门控 SMTP 任务。Telegram 保持独立；邮件关闭时 Telegram 发送失败只记录失败，不会安排 SMTP 发送任务，以保持现有通道隔离。
3. 在 `deploy/sealos/worker-staging.yaml` 中设置 `EMAIL_NOTIFICATIONS_ENABLED: "false"`。未设置该值的其他部署保持当前邮件行为。

## Risks / Trade-offs

- 回滚到不识别新环境变量的镜像时，若 SMTP 凭据仍存在，可能恢复邮件通知 → 回滚前核实目标镜像的行为。
- Sealos 配置只有在新 Worker 镜像和清单生效后才起作用 → 确认新 revision 就绪后再认定线上已关闭邮件。

## Migration Plan

不需要数据迁移。只有分别取得 push 与部署授权后，才发布不可变 Worker 镜像和清单；随后核对生效的 Worker revision 与开关值。若无法验证部署状态，则保持变更未验收，不宣称线上通知行为已改变。
