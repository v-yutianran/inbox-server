## ADDED Requirements

### Requirement: Inoreader 虚拟列表完整采集
系统 SHALL 在单次 Inoreader browser collect 中先等待至少一个可提取 article 就绪，再按稳定 article key 累积滚动过程中发现的唯一条目；系统 MUST NOT 仅因连续两轮可见条目数量相同而停止，也 MUST NOT 把页面未就绪误报为零新增；当一轮没有发现新 key 或达到固定轮次上限时 SHALL 停止。

#### Scenario: body 先于 article 就绪
- **WHEN** Inoreader 的 `document.body` 已出现，但带稳定 key 的 article 延迟渲染
- **THEN** 系统在 60 秒预算内等待至少一个可提取 article，并在就绪后进入滚动采集

#### Scenario: article 在预算内始终未就绪
- **WHEN** Inoreader 未跳转登录页且在内容就绪预算内始终没有可提取 article
- **THEN** 系统显式报告内容未就绪失败，且不更新 baseline、不创建 dispatch job、不发送同步通知

#### Scenario: 等待期间登录失效
- **WHEN** Inoreader 在内容就绪等待期间跳转到登录页
- **THEN** 系统报告登录失效，且不更新 baseline、不创建 dispatch job、不发送同步通知

#### Scenario: 相同数量但 key 已变化
- **WHEN** Inoreader 连续两轮各显示 30 条且第二轮包含新的 article key
- **THEN** 系统继续累积第二轮的新 key，并把两轮唯一条目纳入本次采集结果

#### Scenario: 重叠窗口去重
- **WHEN** 相邻滚动轮次包含重复 article key 和部分新 key
- **THEN** 系统按 article key 去重并保留首次发现顺序

#### Scenario: 没有新 key 时停止
- **WHEN** 当前轮所有 article key 均已在本次采集中出现
- **THEN** 系统停止继续滚动并返回已累计的唯一条目

#### Scenario: 达到轮次上限
- **WHEN** 每轮持续出现新 article key 直到固定轮次上限
- **THEN** 系统在上限处停止并返回上限内累计的唯一条目

#### Scenario: 其它来源保持既有停止行为
- **WHEN** YouTube 或 X 未显式提供稳定 key 策略
- **THEN** 系统继续按既有可见数量稳定规则停止并返回既有结果形态
