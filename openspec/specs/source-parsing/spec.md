# source-parsing Specification

## Purpose
TBD - created by archiving change fix-parity-gaps. Update Purpose after archive.

## Requirements

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

### Requirement: 滴答积压链接可恢复清理
系统 SHALL 在链接发布成功并保存去重状态后逐条清理滴答链接任务，同时最多一个删除请求。已保存链接仍 SHALL 继续清理，但 MUST 不重复发布；没有链接的任务 MUST 保留。删除返回 404 SHALL 视为成功，其它失败 MUST 停止本轮后续删除并传播异常。

#### Scenario: 已发布链接继续清理
- **WHEN** 正常采集发现去重状态已记录但尚未删除的链接任务
- **THEN** 不再发布这些链接，逐条清理任务并保留无链接任务

#### Scenario: 任务已不存在
- **WHEN** 清理某条链接任务时提供商返回 404
- **THEN** 继续清理后续任务

#### Scenario: 清理中途失败
- **WHEN** 删除某条任务返回非 404 错误
- **THEN** 保留未完成任务，停止后续请求，后续正常采集可继续清理而不重复分发
