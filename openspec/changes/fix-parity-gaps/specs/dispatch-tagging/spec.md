## ADDED Requirements

### Requirement: text→flomo 消费时生成智能标签
系统 SHALL 在消费 text 队列项时，若无标签则调 GLM 生成智能标签，按 flomo `#标签` 前缀格式拼接到内容前，再 dispatch。

#### Scenario: text 无标签时生成并拼接
- **WHEN** 消费一个无 tags 的 text 队列项
- **THEN** 系统调 GLM 生成标签，用 fmt_flomo_tags 拼成「#标签1 #标签2 内容」再 dispatch 到 flomo

#### Scenario: GLM 失败不阻塞
- **WHEN** GLM 调用异常或返回空
- **THEN** 系统 SHALL 记录 log.warning，content 原样 dispatch（不加前缀），不阻塞分发

### Requirement: link→cubox 标签保持对等
系统 SHALL 保持 link 队列消费时生成智能标签 + github 来源标签的既有行为。

#### Scenario: link 无标签时生成
- **WHEN** 消费一个无 tags 的 link 队列项
- **THEN** 系统生成智能标签 + github 标签，dispatch 到 cubox
