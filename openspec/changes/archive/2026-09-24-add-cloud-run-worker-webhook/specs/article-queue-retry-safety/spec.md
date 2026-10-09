# Spec Delta

## ADDED Requirements

### Requirement: 文章归档失败阶段必须准确决定 effect 终态
系统 MUST 区分外部归档写入开始前的确定失败与写入开始后可能已有副作用的结果不明。前者 SHALL 进入可审计的失败路径，不得标记为 `uncertain`；后者 MUST 保持 `uncertain` 并禁止自动重复执行。日志 MUST 只记录安全错误码或响应状态类别，不得记录响应正文、原始文章 URL 或凭据。既有 `uncertain` 记录 MUST 不因部署本修复而自动重放或改写。

#### Scenario: 来源 API 在归档写入前拒绝请求
- **WHEN** 文章来源 API 拒绝读取，且归档仓储写入尚未开始
- **THEN** 系统记录可定位的失败原因，将 effect 和任务按失败策略结算，不宣称归档副作用结果不明

#### Scenario: 归档写入开始后出现异常
- **WHEN** 归档仓储写入或后续镜像调用可能已产生副作用且结果无法确认
- **THEN** 系统将 effect 标记为 `uncertain`，冻结自动重试并保留人工核对材料

#### Scenario: 既有不确定记录
- **WHEN** 修复版本部署时已有 `uncertain` 文章任务
- **THEN** 系统不自动修改其终态或重新发起归档
