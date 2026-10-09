# Design

2026-10-09，v3；用户回复继续后实施 ima 切片，随后明确允许修复 Inoreader 并验证归档，且已手工完成登录。

## Context — 当前架构与约束及关联需求

关联需求：[proposal.md](proposal.md)。执行链为队列 → Worker → Git 原文 → ima 镜像 → 归档事件。Control Plane 已提供持久化 getState/putState；Cloud Run 文件系统是临时的，当前文件标记不适用冷启动。不存在 docs/context/README.md；主规格 article-markdown-archive 为边界事实源。

## Goals / Non-Goals

保持 Git 归档与本机兼容，恢复云端 ima。范围及非目标见 proposal.md，不改 API、schema、队列重放规则或浏览器生命周期。

## Decisions — 方案总览

归档领域负责既有状态和业务事件；ima 模块作为 Imperative Shell 处理外部 IO。无新增 Aggregate/Entity，完成标记为可序列化事实。成功事件沿用 article.ima_mirror.succeeded；失败事件沿用 article.ima_mirror.failed，字段不增加 URL、正文、ID 或凭据。

## 详细设计

- DES-001 / REQ-001：读取本机有效凭据，更新指定云 Secret 的新固定版本，不覆盖旧版本；仅发布到现有 Worker，保留旧 revision 回退。Secret 值只经内存/stdin/600 备份读取。
- DES-002 / REQ-002：ima Options 可接收既有 WorkerControlPlane 的 getState/putState；webhook 模式传入控制面，loop 模式保留文件标记。使用 ima-mirror:来源指纹作为 key，原有完成值字段保持不变；成功远程写入后才记录完成事件。读写失败继续失败，不退回临时盘。
- DES-003 / REQ-003：完整分页无匹配时调用当前官方网页 knowledge_tab_writer/create_folder（knowledge_base_id 与根目录 folder_id 都为网页知识库 ID，title 为月份），经 OpenAPI 重新分页确认唯一目录。17:26 真实写入返回 code 51“参数错误”，只读 current_path[0].folder_id 和当前官方前端根目录初始化均确认根目录 ID 等于网页知识库 ID，不能传空字符串。现有 ads2 官方请求的 Cookie、x-ima-cookie、x-ima-bkn 已经原生 HTTP 独立读请求验证（HTTP 200/code 0）；三个认证头保存至中央 config.yaml，再经 Secret IMA_WEB_HEADERS 注入。网页知识库 ID 与 OpenAPI ID 不同，IMA_WEB_KNOWLEDGE_BASE_ID 单独绑定：原生读回 basic_info.name 与目标名称一致后才发布。复用现有 fetch，不新增浏览器运行；网页登录态过期必须失败，不混用 OpenAPI key 或 ID，也不回退根目录。
- DES-001 的来源恢复：新 revision 的自然调度暴露 Inoreader 登录过期。复用 ads2 用户已登录会话，仅导出 Inoreader 域 Cookie/Origin，写入 600 中央配置；备份旧配置及远端凭据后调用已有受 Worker Token 保护的 PUT /internal/credentials/inoreader_creds，沿用现有加密存储并按规范化 JSON 校验读回。复用 buildCollectionJobs 发布一次正常增量采集，不改 baseline、不重放 dead letter、不新增接口或数据库结构。
- DES-001 的本次对账：正常增量采集的 4 篇文章先完成 Git 写入，因错误根目录参数未进入 ima 导入。只读完整目录、对应 Git 原文和持久标记对账后，用户明确同意仅补这 4 篇镜像。使用同一修正版不可变镜像、既有服务身份及 Secret 3 创建单任务 Cloud Run Job，串行复用 createImaArticleMirror/getState/putState；固定已核对的 Git commit、4 个 blob 和来源摘要。dry-run 零写入；任务自动重试为 0，不重新采集、不重放队列、不改变既有 uncertain 状态，不再写 Git；完成后持久化专用对账记录。原 uncertain 记录作为失败审计保留，业务完成由 ima 标记及对账记录说明。

## 数据与接口契约

现有 state API 的 key:string、value:unknown 和 Bearer 服务认证不变；标记仅含 completedAt、contentDigest、knowledgeId 摘要。只有 add_knowledge 成功后写完成值。多实例竞争仍依赖既有任务/effect claim，未知同名文件拒绝导入，不伪造完成标记。默认本机调用仍需 stateDirectory；旧目录、接口和标记保留，不迁移真实历史状态。

## Risks / Trade-offs

- add_knowledge 已成功但状态写失败 → 保留 uncertain 和人工对账门禁，不自动重放。
- 网页登录态过期 → 建目录必须失败并记录安全错误，禁止上传根目录。
- 旧云 revision 回退不具备远程标记 → 保留生产观察记录；不借回退批量重放。
- 不宣称完整 OTel 合规：本切片不新增 SDK、Span 或 Metric，保留现有结构化安全事件，处理边界仅记录一次异常。
- OTel 审查：2026-10-09 核对[当前上游 Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)为 Stable；项目没有初始化 SDK/Instrumentation，SemConv 未使用，Specification 文档未锁定发布版本。不新增或混用语义键；安全日志验证覆盖成功、拒绝、失败且不输出凭据。SDK 生命周期、采样、Trace-Log 关联等不在此处形成合规结论。
- 当前生产 maxScale=1、containerConcurrency=1，webhook 内串行排空；目录创建依赖该既有并发边界，未来扩容前需提供原子建目录协调。

## Migration Plan — 发布与回退

先完成 RED/GREEN 与项目门禁；只读核对并备份现有 service/Secret；更新新版本，发布无流量 revision 并检查健康；双认证及网页目标名称预检通过后切换流量，观察自然任务自动创建当月目录、镜像成功及 ima 独立读回。目录由首篇真实文章按需创建，不能用仅 Ready 作为最终验收。失败停用新 revision 流量并恢复原 fixed Secret/revision；不删除版本、旧流量标签或历史记录。

发布构建记录：原 Dockerfile 的固定基础镜像拉取被 OrbStack 代理 502 阻塞，Google 官方缓存及 Artifact Registry 读取也失败。已核对本机生产镜像 cache 的 RepoDigest/amd64，改用其作基础镜像、原生 legacy builder 构建本次发布产物；重新 npm ci 并完整编译当前 Worker/Domain，生产阶段依赖重新复制，仓库 Dockerfile 不变。构建阶段必须 NODE_ENV=development，避免继承生产环境省略 tsc；生产阶段保持 production。

## 验证策略

聚焦测试覆盖跨实例完成跳过、状态存储拒绝及原有本机行为；全量 npm test/typecheck/build 和 Python 适用门禁；生产核对固定 Secret、新镜像和实际 ima 成功事件。真实归档验收不使用历史 uncertain 回放。目录建档的浏览器验证需本轮明确授权。

## 备选方案与权衡

GCS 或新表不采用：现有状态 API 已提供所需持久化。全改为远程标记不采用：会破坏本机独立运行兼容。自动把文章写入根目录不采用：违反月份组织要求。

## 需求到设计追踪

REQ-001 → DES-001；REQ-002 → DES-002；REQ-003 → DES-003（独立授权及协议切片）。
