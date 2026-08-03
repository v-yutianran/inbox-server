---
status: accepted
---

# Cloudflare Queues 先落 D1 再由 Sealos 领取

Cloudflare 的 HTTP Pull Consumer 要求向 Sealos 提供长期有效且具备 `Queues Edit` 权限的 API Token；Wrangler OAuth 令牌会刷新，不能作为常驻服务凭据。决定由 Cloudflare Worker 使用 Queue consumer binding 接收任务，先以稳定任务 ID 幂等写入 D1 租约收件箱，再确认 Cloudflare 消息；Sealos worker 仅使用现有服务令牌从内部 API 领取和结算租约。

该模式保留 Cloudflare Queues 的至少一次投递语义和 Sealos 单副本 headed Chromium 能力，同时避免把 Cloudflare 个人令牌注入容器。D1 收件箱只承担跨云租约交接，业务终态、外部副作用幂等记录和死信仍由既有 D1 控制面表维护。

具体迁移范围与切换门槛见 [`migrate-to-typescript-cloudflare`](../../openspec/changes/migrate-to-typescript-cloudflare/design.md)。
