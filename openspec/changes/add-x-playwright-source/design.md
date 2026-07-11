## Context

当前系统已有 browser collect 架构：server 不运行浏览器，worker 在有 Xvfb 和 headed chromium 的环境中定时收集 browser source，并复用 login session vault、`IncrementalBaselineRepo`、Redis 队列和 Cubox destination。X 的 Bookmarks 与 Likes 需要登录态，但用户无法使用 OAuth，因此本变更只能走 Playwright 网页采集。

X 网页 DOM 和反爬策略不如官方 API 稳定，本设计目标是把风险限制在新增 source 内：凭据失效或页面结构变化只影响 `x_bookmarks`/`x_likes`，不影响其他 source 和队列消费。

## Goals / Non-Goals

**Goals:**

- 新增 `x_bookmarks` 与 `x_likes` browser source，使用同一个 `x` storage_state 登录态。
- 从 Bookmarks 与 Likes 页面提取 tweet id、作者、正文和推文链接。
- 按 tweet id 复用持久化基准去重，重复出现在收藏和喜欢中的推文只入队一次并合并标签。
- 入队为现有 `link` payload，最终由 Cubox 分发保存。
- 提供单元测试覆盖解析、去重、合并标签和错误隔离。

**Non-Goals:**

- 不接入 X OAuth 或 X API。
- 不自动完成 X 登录，也不保存账号密码。
- 不同步取消收藏、取消喜欢或删除 Cubox 中已有内容。
- 不新增数据库表或生产依赖。

## Decisions

### 使用 session 类凭据 `x`

X Bookmarks 与 Likes 都依赖完整浏览器登录态，适合复用现有 Playwright `storage_state` 导入流程。登录策略只校验当前页面仍处于登录态，不处理账号密码登录，避免新增敏感凭据形态。

替代方案是通过 cookie 字段手工写入 vault，但 X 登录态通常涉及多 cookie 和 localStorage，完整 `storage_state` 更贴近已有 inoreader/youtube 模式。

### 一个 scraper 支持两个 timeline

新增纯解析函数处理页面中 `article[data-testid="tweet"]` 节点，将 DOM 结果转换为内部 `XTweet` 数据。Bookmarks 与 Likes 只差入口 URL 和标签，复用同一 scraper 能减少页面结构变化时的维护面。

### 基准 key 使用 tweet id

推文链接可能因用户名变更而变化，但 tweet id 稳定。`x_bookmarks` 和 `x_likes` 分别维护 source 基准；跨列表合并在单次 collect 内按 tweet id 汇总标签，避免同一推文在同一轮重复入队。

### 入队 payload 保持 link 兼容

payload 使用推文 permalink 作为 `url`，标题优先使用作者和正文摘要，标签包含 `x` 与来源标签 `x-bookmarks`/`x-likes`。Cubox destination 无需理解新的 payload 类型，现有限速和失败重试保持不变。

## Risks / Trade-offs

- X DOM 结构变化 → 解析函数集中在新增 scraper，测试固定解析契约；失败时返回 collect meta，不影响其他 source。
- 登录态失效 → 登录策略抛出 `LoginExpired`，source 错误被 browser collect 隔离并记录。
- 首次历史量较大 → 复用现有 link 队列限速和 Cubox 日限额削峰；不在 source 内新增限流。
- Likes 页面可能只加载部分历史 → 首次同步定义为“按页面滚动可见范围采集”，后续运行仍以 tweet id 去重。

## Migration Plan

1. 导入 X 登录态：用现有 Playwright state-save 流程保存 `storage_state`，再通过 `scripts/import_credentials.py` 写入 credential vault，credential name 使用 `x_creds`。
2. 在 channels 配置中启用 `x_bookmarks` 和/或 `x_likes`，collection id 使用目标 Cubox collection。
3. 启动 worker 后由 browser collect 定时采集；如需避免首次大量重复，可先运行新增 baseline 脚本预填基准。
4. 回滚时禁用对应 source；已入队和已保存 Cubox 的链接不自动删除。
