## ADDED Requirements

### Requirement: X 收藏与喜欢列表采集
系统 SHALL 支持启用 `x_bookmarks` 与 `x_likes` browser source，通过 Playwright storage_state 登录态读取当前 X 账号的 Bookmarks 收藏列表和 Likes 喜欢列表。

#### Scenario: 采集收藏列表
- **WHEN** `x_bookmarks` source 已启用且 `x_creds` 登录态有效
- **THEN** 系统 SHALL 打开 X Bookmarks 页面，提取页面可见推文并转换为 link payload 入队

#### Scenario: 采集喜欢列表
- **WHEN** `x_likes` source 已启用且 `x_creds` 登录态有效
- **THEN** 系统 SHALL 打开当前 X 账号 Likes 页面，提取页面可见推文并转换为 link payload 入队

#### Scenario: 登录态失效不阻塞其他来源
- **WHEN** X 登录态失效、页面跳转登录或页面采集失败
- **THEN** 系统 SHALL 返回包含错误信息的 collect meta，不抛出异常阻塞其他 source 或 worker 消费

### Requirement: X 推文按 tweet id 增量去重
系统 SHALL 使用 tweet id 作为持久化基准 key，确保已处理推文后续不会重复入队。

#### Scenario: 首次启用采集可见历史
- **WHEN** `x_bookmarks` 或 `x_likes` source 已启用且持久化基准为空
- **THEN** 系统 SHALL 将页面滚动可见范围内的推文入队，并把对应 tweet id 写入基准

#### Scenario: 后续只收新增推文
- **WHEN** `x_bookmarks` 或 `x_likes` source 已启用且持久化基准已有 tweet id
- **THEN** 系统 SHALL 只入队未出现在基准中的推文，并更新基准

#### Scenario: 收藏和喜欢重叠时合并标签
- **WHEN** 同一个 tweet id 在同一轮收藏和喜欢采集中都出现
- **THEN** 系统 SHALL 只入队一次，并在 payload tags 中同时包含 `x-bookmarks` 与 `x-likes`

### Requirement: X 推文入队格式
系统 SHALL 将 X 推文转换为现有 link 队列可消费的 payload，复用 Cubox 分发、link 限速和重试逻辑。

#### Scenario: 推文转换为 link payload
- **WHEN** X 页面返回包含 tweet id、作者和正文的推文
- **THEN** 系统 SHALL 入队 `url` 为推文 permalink、`title` 为作者与正文摘要、`tags` 包含 `x` 和来源标签的 link payload

#### Scenario: 推文缺少有效链接时跳过
- **WHEN** X 页面中的条目无法提取 tweet id 或 permalink
- **THEN** 系统 SHALL 跳过该条目，不入队无效 link
