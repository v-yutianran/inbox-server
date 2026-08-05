## MODIFIED Requirements

### Requirement: link→cubox 标签保持对等
系统 SHALL 保持 link 队列消费时生成智能标签 + github 来源标签的既有行为，并 SHALL 在 Cubox 成功后提交独立文章归档任务；归档结果 MUST NOT 改变 Cubox 分发的成功状态。

#### Scenario: link 无标签时生成
- **WHEN** 消费一个无 tags 的 link 队列项
- **THEN** 系统生成智能标签 + github 标签，dispatch 到 cubox

#### Scenario: Cubox 成功后提交归档任务
- **WHEN** link 队列项已经携带最终标签且 Cubox 返回成功
- **THEN** 系统 SHALL 提交独立文章归档任务，并 SHALL 将 link 队列项按 Cubox 成功完成

#### Scenario: Cubox 未成功时不提交归档任务
- **WHEN** Cubox 返回失败、配额限制或抛出异常
- **THEN** 系统 MUST NOT 提交文章归档任务，并 SHALL 沿用现有 link 重试或限额处理
