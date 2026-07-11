## Why

用户希望把 X（Twitter）的 Bookmarks 收藏列表和 Likes 喜欢列表自动转存到 Cubox，但当前无法使用 X OAuth/API 授权。需要通过已有 headed Playwright 登录态能力采集这两个列表，并复用现有队列与 Cubox 分发链路。

## What Changes

- 新增 `x_bookmarks` 与 `x_likes` 两个 browser source，使用 Playwright storage_state 登录态访问 X 网页。
- 首次启用时按页面可见历史内容全量采集，后续按 tweet id 持久化基准去重，只入队未见过的推文。
- Cubox 入库内容以推文链接为主，并携带作者、正文摘要与来源标签；收藏与喜欢重叠时只入队一次，并合并 `x-bookmarks`、`x-likes` 标签。
- 登录态沿用现有 session 类凭据导入流程，不引入 X OAuth、X API 或新增生产依赖。

## Capabilities

### New Capabilities

- `x-playwright-source`: 通过 Playwright 登录态从 X 收藏和喜欢列表采集推文，并以增量方式入队转存。

### Modified Capabilities

- 无。

## Impact

- 影响 browser source 插件、登录策略注册、source 配置校验、默认渠道示例、凭据导入说明和对应单元测试。
- 复用现有 `incremental_baselines` 持久化表记录已处理 tweet id，不需要数据库迁移。
- X 页面 DOM 或反爬策略变化会影响该 source，但不应阻塞其他 source 收集。
