## Context

当前系统已有 API source（telegram、dida）和 browser source（知乎、B 站、YouTube 等）。GitHub Star 不需要浏览器登录态，使用 GitHub REST API 即可读取当前账号已 Star 的仓库，因此应接入 API source 编排。

GitHub 官方 REST API 提供 `GET /user/starred`，支持按 Star 时间排序、分页读取当前账号 Star 的仓库。细粒度 Token 需要 `Starring` 读权限；经典 Token 可按 GitHub 现有规则授权。

## Goals / Non-Goals

**Goals:**

- 新增 `github_stars` source，从当前 GitHub 账号读取 Star 仓库。
- 首次启用时把历史全部 Star 入队到 `link`。
- 后续运行只入队新增 Star，并把已见仓库持久化到 `incremental_baselines`。
- 复用现有 Cubox 分发、link 限速和 github 标签逻辑。

**Non-Goals:**

- 不同步 unstar 删除行为，不从 Cubox 删除已保存链接。
- 不新增浏览器登录流程。
- 不新增数据库表或生产依赖。

## Decisions

### 使用 GitHub REST API 而不是浏览器抓取

GitHub Star 是稳定的 API 资源，使用 Token 调用 `GET /user/starred` 更容易测试，也不依赖 worker 的 headed chromium。浏览器抓取会引入登录态维护、页面结构变化和反爬风险，不符合最小必要改动。

### 复用 `IncrementalBaselineRepo`

现有 `incremental_baselines` 已用于“已知收藏 key 集合”。GitHub Star 的已知 key 可以使用仓库 `html_url`，因此不需要新增表。source 名固定为 `github_stars`，避免与其他来源共享基准。

### 按 Star 时间倒序分页并遇到整页已知后停止

API 请求使用 `sort=created`、`direction=desc`、`per_page=100`。首次没有已知 key 时会翻完整个历史；后续新 Star 会排在前面，遇到一页全部已知即可停止，减少 API 调用。

### link payload 保持现有格式

入队 payload 使用 `{"url": html_url, "title": full_name, "tags": []}`。消费阶段已有逻辑会对 GitHub URL 追加 `github` 标签并生成智能标签，因此 source 不重复实现标签逻辑。

## Risks / Trade-offs

- GitHub Token 权限不足或过期 → source 返回错误 meta，不影响其他 source。
- 历史 Star 数量很大 → 首次入队会产生较多 link；现有 link 队列限速和 Cubox 限额负责削峰。
- GitHub API 限流 → 当前先按普通异常处理，后续如有需要再增加专门限流状态。
