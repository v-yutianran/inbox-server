# Design

## Context

见 [proposal.md](proposal.md)。公共 `createQueueProducer` 被定时调度、D1/Neon 控制面和迁移工具复用。GitNexus 索引落后一个提交且调用边缺失，源码确认实际调用点。主规格的旧 D1/切换段落与当前 Neon 运行时不一致，本次仅追加队列约束，不修改迁移中的权威数据路径。

## Goals / Non-Goals

目标是恢复现有正常采集，不改变消息或分发契约。领域状态仍由控制面拥有；用例为有效任务批量发布；不变量为先验证全部输入、保持幂等键、全部发布成功后才推进采集状态。现有 QueueJob 值对象和 QueueProducer 接口已足够；无需新增 Aggregate、Entity 或 Domain Event，未改变业务状态机。

## Decisions

在基础设施生产者中完整解析并计算 JSON 的 UTF-8 字节大小，然后顺序发送有界批次。每条预留 100 字节元数据，按官方 KB=1000 的较保守边界限制单条 128000、单批 256000 字节。无需来源专属分页或新配置；优于只修滴答或逐条发消息。平台依据：[Queues 限制](https://developers.cloudflare.com/queues/platform/limits/) 与 [JavaScript API](https://developers.cloudflare.com/queues/configuration/javascript-apis/)。

保留 native Queue JSON 默认格式与原异常，不增加内部重试。分批的 Promise 全部完成才返回。部分发布重试沿用既有稳定 dedupeKey/effect 去重；不扩大为事务性 outbox。

滴答用例保留 `collect → publish → save state → afterCommit` 顺序，任务由滴答服务拥有，去重状态由控制面拥有。纯解析函数已把保存过的链接任务纳入清理列表；只在 HTTP 基础设施中把并发 DELETE 改为顺序请求。404 仍视为成功，其它错误立即传播并停止后续请求，后续正常采集不重发已保存链接。无需新领域模型、重试配置或完成任务接口。

otel-spec 审查：本项目未配置 OTel SDK/Instrumentation/Semantic Conventions；可选传递依赖不视为已启用。复用 Cloudflare 请求/队列日志及 Cloud Run `worker.job.*`，不新增逐批 Span、伪造 TraceId 或重复异常日志；最终失败仍由现有处理边界记录。本次不宣称完整 OTel 合规。核验成功、拒绝与后续批次失败，并用真实 publish HTTP 状态、采集终态和目标 effect 读回关联。

生产 ima 已出现 `api_rejected`，既有失败处理边界只补充可选数值 `providerCode`，不记录提供商正文、文章内容或凭据；保留 reason/stage/异常字符串，不新增信号或改变归档状态机。

本轮三条已写 Git 但 ima 拒绝的文章逐项对账：核验 Git 副本、生产知识库与月份目录、文件预检和持久标记，沿用现有镜像实现及 article 限速，仅补缺失副本，独立读回正文与摘要。控制面把 uncertain 作为终态；保留其历史审计，以真实镜像结果和归档事件记录恢复，不清除限额或重放队列。

## Risks / Trade-offs

- 多批发送不能原子提交 → 完整输入先验证；远端失败立即传播，调用者不更新采集状态，重试依赖既有幂等。
- 元数据大小由平台管理 → 每条预留官方说明的约 100 字节，并采用十进制上限；边界与多字节内容测试。
- 生产积压受现有限速保护 → 不删除限速或重放历史死信；验证采集清理与实际分发结果分别报告。
- 提供商请求失败 → 停止本轮后续删除，保留剩余任务及既有去重状态；正常采集重试可继续清理，具体提供商请求速率上限尚无证据。

## Migration Plan

先聚焦 RED/GREEN/REFACTOR，再执行适用测试、类型与构建门禁。Wrangler 同配置 dry-run 后部署现有 inbox-server-api，保留 live vars/secrets 和所有绑定。生产验证暴露清理问题后，同样完成 Worker 聚焦回归与门禁；以当前生产镜像不可变 digest 为基础只追加重新编译的清理模块，核对层内容和运行配置。Cloud Run 新修订先无流量检查就绪，再切换流量，保留凭据、资源和旧修订。仅通过正常滴答采集继续验证；任务已完整备份并校验，读回未完成任务、去重状态、成功日志和分发 effect。回滚需独立授权。
