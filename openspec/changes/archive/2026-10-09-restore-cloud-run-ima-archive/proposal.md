# Proposal

## Why — 背景与问题

2026-10-09 实查 Cloud Run Worker 的固定 Secret 版本中 ima 被关闭且没有凭据；本机 OpenAPI 认证有效，目标知识库缺少 202610 文件夹。Cloud Run 临时文件系统也不能保存跨实例的镜像完成记录。

## What Changes

- 恢复现有 Cloud Run 的 ima 配置并从真实运行时核对归档结果。
- 云端复用控制面的持久化完成记录，保留本机文件标记兼容行为。
- 缺失月份目录自动创建并读回确认，名称冲突和未确认副作用继续阻止重复上传。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `article-markdown-archive`：补充 Cloud Run ima 镜像、月份目录和跨实例完成状态要求。

## Impact

Worker ima 镜像和入口、既有控制面 state API、Cloud Run 镜像及 Secret。无新依赖、数据库迁移、Git 归档格式变化。与 active `add-cloudflare-access-ima-mirror` 的 ima 部分重叠：本 change 替代其人工预建目录及仅持久卷标记假设，不涉及其 Console Access 验收；Git 目录遵从现行主规格 `sources/article`。

## 目标与成功指标

现有 Cloud Run 向唯一目标知识库的正确月份目录归档成功；冷启动重投不再次上传；秘密不进入日志或仓库。

## 范围与非目标

范围为 ima 镜像链路，以及用户另行明确授权的 Inoreader 登录态恢复、一次正常增量采集和本次建目录失败的 4 篇文章仅补 ima 镜像。非目标为历史 uncertain 队列批量重放、其它来源登录问题、Console Access 和云基础设施重构。

## 需求清单

| ID | 优先级 | 需求与来源 |
| --- | --- | --- |
| REQ-001 | P0 | 恢复云端 ima 认证和启用配置，完成文章归档；来自本轮修复请求。 |
| REQ-002 | P0 | 完成标记跨 Cloud Run 冷启动保留，本机旧路径继续有效；来自运行时持久性约束。 |
| REQ-003 | P0 | 缺失 YYYYMM 文件夹自动创建，重复目录和未知同名文章拒绝写入；来自用户自动建目录要求。 |

## 验收标准

- AC-001 / REQ-001：Given 已启用且认证有效，When Cloud Run 正常处理一篇待归档文章，Then ima 目标月份目录可读回该文章且出现 `article.ima_mirror.succeeded`。
- AC-002 / REQ-002：Given 已确认完成记录，When 更换实例并重投同来源，Then 不调用 ima 或 COS；存储失败不误报完成。
- AC-003 / REQ-003：Given 没有目标月份目录，When 镜像开始，Then 创建一次并读回唯一目录再上传；重复名称或创建失败不上传。

## 业务规则与风险

Git 原文仍先完成归档。镜像只有 add_knowledge 成功且标记持久化后才完成；无标记的同名文档仍待对账。官方 OpenAPI 1.1.10 未提供建目录接口，网页认证与 OpenAPI 认证不可混用；用户回复继续后按已提出的 ads2 ima 登录态范围实施，原生 HTTP 网页读请求验证成功。网页登录态存在过期风险，失效时失败且可定位；不进行历史数据重放。

## 需求覆盖检查

REQ-001 → AC-001；REQ-002 → AC-002；REQ-003 → AC-003。验收执行事实记录于 acceptance.md，技术选择记录于 design.md。
