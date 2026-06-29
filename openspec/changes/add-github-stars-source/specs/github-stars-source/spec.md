## ADDED Requirements

### Requirement: GitHub Star 仓库收集
系统 SHALL 支持启用 `github_stars` source，通过 GitHub Token 读取当前账号已 Star 的仓库，并把仓库链接入队为 `link`。

#### Scenario: 首次启用导入历史 Star
- **WHEN** `github_stars` source 已启用且持久化基准为空
- **THEN** 系统 SHALL 分页读取当前账号全部已 Star 仓库，并为每个仓库入队一个 link payload

#### Scenario: 后续只收新增 Star
- **WHEN** `github_stars` source 已启用且持久化基准已有仓库 URL
- **THEN** 系统 SHALL 只把未出现在基准中的仓库入队，并更新基准

#### Scenario: GitHub API 失败不阻塞其他来源
- **WHEN** GitHub API 请求失败、返回非法响应或 Token 无效
- **THEN** 系统 SHALL 返回包含错误信息的 collect meta，不抛出异常阻塞其他 source

### Requirement: GitHub Star 入队格式
系统 SHALL 将 GitHub Star 仓库转换为现有 link 队列可消费的 payload，复用 Cubox 分发、link 限速和 GitHub 标签逻辑。

#### Scenario: 仓库转换为 link payload
- **WHEN** GitHub API 返回一个包含 `html_url` 和 `full_name` 的仓库
- **THEN** 系统 SHALL 入队 `url` 为 `html_url`、`title` 为 `full_name`、`tags` 为空列表的 link payload

#### Scenario: 仓库缺少 URL 时跳过
- **WHEN** GitHub API 返回的仓库缺少可用 `html_url`
- **THEN** 系统 SHALL 跳过该仓库，不入队无效 link
