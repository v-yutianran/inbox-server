## ADDED Requirements

### Requirement: dida 任务标题解析 markdown 链接
系统 SHALL 用纯函数 `extract_url_and_title(title, content)` 从 dida 任务标题/内容提取 (url, 干净标题)，复刻老 dispatcher 4 分支逻辑，使得 cubox 书签标题不再残留原始 md 链接格式。

#### Scenario: 标题是 md 链接
- **WHEN** task title 为 `[文本](https://e.com)` 格式
- **THEN** 返回 (url=`https://e.com`, title=`文本`)，cubox 书签标题为干净的「文本」

#### Scenario: 标题是裸 URL
- **WHEN** task title 以 http 开头
- **THEN** 返回 (url=title, title=`""`)，cubox 标题回退为 url 本身

#### Scenario: 内容含 URL
- **WHEN** task title 为普通文本且 content 含 URL
- **THEN** 返回 (url=content 中的 url, title=task title)

#### Scenario: 无 URL 不入队
- **WHEN** task title 与 content 均无 URL
- **THEN** 返回 (None, None)，该任务不入 link 队列
