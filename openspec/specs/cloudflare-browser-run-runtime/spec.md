# cloudflare-browser-run-runtime Specification

## Purpose
定义 Cloud Run worker 在收到任务时按需连接 Cloudflare Browser Run、在任务结算后释放远程会话，并在来源兼容性未经验证时阻止生产切换的契约。

## Requirements

### Requirement: 独立受保护的远程浏览器模式
worker 在 Cloudflare Browser Run 模式下 MUST 从受保护配置取得账户身份与访问令牌，SHALL 通过加密 CDP 连接远程浏览器，不得将令牌输出到日志、异常响应或任务数据。

#### Scenario: 凭据缺失
- **WHEN** 远程模式缺少账户身份或访问令牌
- **THEN** worker 拒绝启动处理，且错误不包含令牌内容

#### Scenario: 连接失败
- **WHEN** 浏览器服务拒绝连接或超时
- **THEN** 当前批次不产生成功结算，入口返回可重试失败且释放已创建资源

### Requirement: 请求范围内的浏览器生命周期
webhook 模式 MUST 仅在处理需要浏览器的批次时持有有效远程浏览器，SHALL 在批次完成或失败后主动终止远程会话而非仅断开客户端连接；异常断线后的空闲兜底 SHALL 为 60 秒。无请求时 MUST 不持续占用浏览器分钟数。

#### Scenario: 浏览器任务完成
- **WHEN** 请求领取到需要浏览器的任务且业务处理和结算完成
- **THEN** 远程会话关闭后请求才报告成功，服务端记录正常关闭

#### Scenario: 空批次或非浏览器任务
- **WHEN** 请求未领取任务或批次无需浏览器
- **THEN** 不创建远程浏览器会话

#### Scenario: 任务中途失败
- **WHEN** 浏览器任务异常或请求被停止
- **THEN** 尝试安全终止远程会话且任务保持可恢复的租约/结算状态

#### Scenario: 客户端异常断线
- **WHEN** 客户端断开且无法发送主动关闭命令
- **THEN** 服务端按 60 秒空闲超时释放浏览器

#### Scenario: 主动关闭失败
- **WHEN** 服务端关闭命令失败
- **THEN** 客户端连接仍释放且批次不报告清理成功

### Requirement: 本地模式兼容与来源验收
现有 Sealos headed 模式 SHALL 保持原行为；Cloud Run 远程模式切换生产前 MUST 对每个已启用浏览器来源核对登录、解析、基线及去重，未经核对的来源不得视为可用。

#### Scenario: 旧部署启动
- **WHEN** 现有 Sealos 配置未选择远程模式
- **THEN** worker 仍按既有 headed 浏览器契约启动

#### Scenario: 来源尚未通过验收
- **WHEN** 知乎、B站、Inoreader 或 YouTube 任一启用来源缺少真实兼容性证据
- **THEN** 生产迁移保持阻塞并记录该来源的未验证状态
