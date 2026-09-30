# Proposal

## Why

Inbox Server 在批次结束时仅断开 Playwright CDP 连接，Cloudflare 浏览器仍空闲运行十分钟，产生额外计费。需要主动关闭远程浏览器，并将异常断开后的空闲兜底缩短至用户指定的 60 秒。

## What Changes

- 批次成功或失败后发送 CDP `Browser.close`，随后释放客户端连接。
- `keep_alive` 从 600000 改为 60000 毫秒。
- 保留本地 headed 模式与现有队列结算行为；验证成功、业务失败和断线兜底。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cloudflare-browser-run-runtime`：明确远程会话终止与 60 秒空闲兜底。

## Impact

影响 worker 的浏览器连接和批次清理边界，不新增依赖，不修改业务数据或来源采集逻辑。生产仅替换当前镜像中的浏览器模块，保留原 revision 用于回退。
