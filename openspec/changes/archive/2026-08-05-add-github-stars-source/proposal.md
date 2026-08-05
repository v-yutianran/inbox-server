## Why

GitHub Star 是当前收集工作流中的重要链接来源，但现有 source 不支持从 GitHub Star 自动入队。新增该能力后，用户在 GitHub 当前账号 Star 仓库即可自动进入 link 队列，并最终由 Cubox 分发保存。

## What Changes

- 新增 `github_stars` API source，使用 GitHub Token 拉取当前账号 Star 的仓库。
- 首次启用时导入历史全部 Star，后续通过持久化基准只入队新增 Star。
- 入队内容类型为 `link`，目标复用现有 Cubox 分发流程。
- 不新增生产依赖，不引入浏览器登录态。

## Capabilities

### New Capabilities

- `github-stars-source`: 从当前 GitHub 账号 Star 仓库收集链接，并以增量方式入队。

### Modified Capabilities

- 无。

## Impact

- 影响 `channels.yaml` source 配置、渠道配置校验、API source 编排、source 插件和对应测试。
- 复用现有 `incremental_baselines` 持久化表记录已处理仓库，不需要数据库迁移。
- GitHub API 失败只影响该 source，不应阻塞其他 source 收集。
