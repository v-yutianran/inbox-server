# Proposal

## Why

滴答积压链接去重后超过 100 条，控制面一次调用 Cloudflare Queues sendBatch 导致发布失败。修复发布后，真实验证又发现并发清理积压任务收到提供商 500；需要恢复发布和清理完整链路。

## What Changes

- 公共生产者按消息数和 UTF-8 序列化大小顺序分批发布，完整验证输入后才开始写入。
- 保留消息版本、幂等键、调用接口和异常传播；所有批次成功后采集器才保存状态并执行既有清理。
- 滴答清理逐条执行，遇非 404 错误停止；保留已发布链接的去重状态，后续采集继续清理。
- 补上批量边界、清理并发与中途失败回归，部署 Cloudflare API 和 Cloud Run Worker，验证真实滴答链路。
- 真实分发观察到 ima 业务拒绝但日志缺少错误码，补充仅数值返回码的诊断字段，保持错误与重试契约。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cloudflare-application-runtime`：队列批量发布遵守平台上限并保持失败与重试语义。
- `source-parsing`：滴答积压链接发布后的可恢复清理。

## Impact

修改 API 公共队列生产者和 Worker 滴答清理及其测试；定时调度、控制面分发与迁移发布复用公共生产者。无新依赖、schema 迁移或凭据变更。生产验证触发正常滴答增量采集，不重放历史死信。
