# Design

## 关联需求

REQ-001—003 和 AC-001—003 来自 [proposal.md](proposal.md)；行为细节以本 change 的 spec delta 为准。

## Context

版本 1；范围与需求见 [proposal.md](proposal.md) 和 [spec delta](specs/cloudflare-application-runtime/spec.md)。生产 D1 在 2026-09-23 的只读盘点有 23 张业务表、约 26 万行，数据库约 129 MB；旧 Docker PostgreSQL 卷另有 3,556 条业务行，旧 Redis 卷有 21 个 pending 与 14 个 dead-letter 队列元素。旧 PG 与 D1 的同名表逐主键对照发现 97 个旧侧独有主键；Redis 元素未能凭顶层 ID 字段与 D1 精确关联，语义覆盖仍未知。Neon `dbx` 当时仅有一张既有 `public` 表。API 的 Queue 入站、任务/效果终态、死信重放、运维历史和加密凭据目前共同依赖 D1，部分状态变更依赖 `database.batch()` 原子提交。浏览器 worker 经 API 读写这些状态，因此持久层属于 API 的控制面，而不属于 Cloud Run 容器。

## Goals / Non-Goals

**Goals:** 完整保留 D1 业务行和主键，并可恢复地保存旧持久卷中无法证明已覆盖的数据；使 Neon 成为唯一权威持久源；保持 Queue 入站先落库再确认、租约、限速延期、效果幂等、死信重放和可回退切流。

**Non-Goals:** 改 API/worker HTTP 契约、替换 Cloudflare Queue、重写领域决策、把业务凭据或恢复信封仅存于 Redis、迁移 Cloudflare 内部 `_cf_KV` 与 `d1_migrations` 元数据。

## 当前架构与约束

Cloudflare API 是唯一状态所有者，Cloud Run worker 通过已鉴权 HTTP 控制面读写；Cloudflare Queue 与数据库没有共同事务。任务终态、限速、重放不变量仍由现有纯策略决定。现有 `STATE_ENCRYPTION_KEY` 必须保持一致，才能读取三个密文字段。

## 方案总览

API 将 D1 仓储替换为 Hyperdrive→Neon；Cloudflare Queue 继续传递消息，Cloud Run worker 继续调用 API；Upstash REST 只缓存可重建的心跳。Neon `inbox_server` schema 持有完整历史与所有权威状态。

## Decisions

### DES-001 PostgreSQL 事务承载全部长期状态（REQ-001、REQ-003）

在现有 `dbx` 数据库建立独立 `inbox_server` schema，版本化 SQL 管理 23 张业务表、约束和索引；不改动既有 `public` 对象。保留字符串时间与 JSON 序列化语义，SQLite BLOB 转 PostgreSQL `bytea`，迁移时显式保留自增 ID 并校正 sequence。SQLite 64 位整数保持 PostgreSQL `bigint`；运行时读取时仅将安全整数转为 JavaScript number，超出安全范围即报错，避免计数在字符串拼接或精度丢失中改变。跨表状态更新使用同一 PostgreSQL 事务；队列租约采用行级锁/条件更新，不能把 D1 的 `INSERT OR IGNORE` 或 `?` 占位符原样送入 PostgreSQL。备选是逐表双写 D1/Neon，跨两个数据库无法原子提交，故不采用。

### DES-002 Cloudflare API 通过 Hyperdrive 访问 Neon（REQ-001）

Cloudflare Worker 增加 Hyperdrive binding 和 `nodejs_compat`，以受支持的 PostgreSQL 驱动在每次请求/Queue/Cron 生命周期内获取和关闭连接；事务只在同一连接执行。Cloudflare 官方将 Hyperdrive 列为 Neon 推荐连接方式，且支持原生驱动和连接池；备选 Neon serverless driver 可连接，但不复用 Hyperdrive 池。Hyperdrive 创建需要 Neon 当前连接凭据；DBX 已保存密码不能充当运行时 secret。连接故障时 API 失败关闭，Queue 不确认，禁止退回 D1 隐式写入。

### DES-003 Redis 仅承载可重建短期状态（REQ-002）

迁移 D1 `worker_rate_limits`、`worker_rate_limit_batches`、`worker_heartbeats` 的**全部既有行**到 Neon，包括历史值。限速决定仍由 PostgreSQL 原子事务保护，避免 PostgreSQL/Redis 双写改变额度或丢失延期；Upstash REST 只作为带 TTL 的最新心跳/在线状态缓存，失效时由 Neon 最新行重建。备选把限速计数完全移到 Redis，短期键失效会改变已消费额度且无法与任务事务原子提交，故不采用。Cloudflare Worker 需要 Upstash REST URL/token；用户提供的 `rediss://` 密码不等于 REST token，二者不能互换。

### DES-004 一致快照、逐表核对、单向切流（REQ-001、REQ-003）

先冻结旧路径的业务写入并等待队列入站与 worker 租约安定，做 D1 一致导出及可校验本地加密备份，再向独立 schema 导入。每表核对行数、排序后主键摘要、关键关联和业务不变量；对 BLOB/JSON 采用规范化字节摘要，抽样测试凭据解密但不记录明文。重复导入只可在隔离目标或同一快照的幂等模式执行；不混合两个不同时刻的 D1 快照。禁副作用 shadow 与回退演练通过后更新 Cloudflare API binding 并切换权威写入。旧 D1 保留只读直到观察期结束。切流后若需回退，先停止新写入并从 Neon 核对/回补增量；禁止直接让旧 D1 覆盖新状态。

### DES-005 保持领域和 HTTP 边界（REQ-001、REQ-002）

`ControlPlaneService`、`QueueInboxService` 和运维服务的外部接口维持现状，仅替换持久化实现；纯领域策略继续在 `@inbox/domain` 和现有策略模块，API Handler 不承载新规则。结构化日志仅记稳定事件、表名/计数/状态与追踪关联，不记连接串、token、密文或行内容。队列重试、Neon/Upstash 失败、超时和取消均在边界区分，避免同一失败重复异常日志。

### DES-006 旧卷差异独立保全（REQ-001、REQ-003）

旧 PG/Redis 归档先按字节校验并保持只读。逐表比较稳定主键及可判定的业务身份；旧 PG 与 D1 可能复用主键，不能把同名主键视为同一记录。最小保全单位是两份已校验的源卷归档文件：在 Neon 独立 schema 以来源、镜像版本、字节长度及 SHA-256 标识保存原始字节，写后回读比对；源卷成员和队列位置均由归档自身保留，可按固定镜像恢复。此方式避免在业务身份尚未知时转换、合并或重放历史行。确认业务身份和当前终态之前不并入权威表、不自动回放；直接按旧主键合并或重放 Redis 列表存在覆盖和重复副作用风险，故不采用。

**2026-09-24 后续容量整理状态：** 上述 Neon 归档是迁移时点的历史事实。本机受限 tar 的文件大小与 SHA-256 清单一致，隔离恢复证据已复核；随后 Neon `inbox_server_legacy.volume_archives` 中两行原始字节已按精确 BYTEA 值删除，对已空表执行 `TRUNCATE`，当前保留表结构且行数为 0。当前旧卷恢复来源为本机受限 tar `/Users/xinwu/.backup/inbox-server-legacy-volumes-2026-09-24/`，隔离恢复记录见同目录 `REPORT.md`。该 tar 是本机副本，未证明存在异地备份，不能称为异地备份。旧 PG 内容对账及 Redis 33 项 IMA 人工交接结论不变。

### DES-007 切流后隔离回退演练（REQ-003）

以已校验的冻结 D1 SQLite 快照为只读基线，将当前 Neon 的 23 张业务表在一致只读事务中流式写入**另建的本地 SQLite 副本**；副本只保留 D1 的 schema/元数据，业务行以 Neon 当前完整状态替换，避免按主键增量合并时遗漏删除或覆盖新状态。写前核对表、列、类型及目标快照摘要；写后逐表比较行数和顺序无关的内容摘要，检查 SQLite 完整性与外键，失败则丢弃副本。预检不得写入，工具不得连接或覆盖线上 D1。随后在无外部分发的隔离运行时读取该副本并核对关键状态与 API 契约，记录耗时和恢复步骤。此演练证明可从 Neon 构造可核对的 D1 数据副本；真正生产回滚仍须独立授权、先冻结 Neon 写入并复核最后增量，不能直接把旧 D1 切为权威。

## 详细设计

状态所有者、事务边界、迁移序列及故障处理分别由 DES-001—006 定义。修改的 Aggregate 为任务及其效果/信封/死信记录；`claim`、`finish`、`replay` 是命令，已发生的任务终态仍由现有持久记录表达，不额外引入双份事件日志。

## 接口契约

现有 `ControlPlaneService`、`QueueInboxService`、运维 HTTP 路径、Queue 消息版本和鉴权保持兼容。新增运行时绑定为 Hyperdrive 与 Upstash REST URL/token；缺失或不可用时依赖调用失败关闭，Queue 消息留待重试，不回退 D1 写入。

## 验证策略

先用合成数据验证 PostgreSQL 迁移、并发租约、任务跨表事务、Redis 故障及 API 契约；再用冻结的生产快照逐表计数/主键摘要、关联、密文解密抽样和 shadow 无副作用运行；最后进行真实连接、单批次来源和回退演练。每阶段只记录可定位结果，不将计划当成通过。

## OpenTelemetry 边界审查

仓库当前未锁定 OpenTelemetry SDK 或埋点包，故本变更不宣称已有 OTel 合规信号。若接入 SDK，版本须与上游 [Semantic Conventions 1.44.0](https://opentelemetry.io/docs/specs/semconv/) 核对：HTTP 入口、Queue 处理及 webhook 分别是 SERVER/CONSUMER/CLIENT 边界；Hyperdrive→PostgreSQL 是 CLIENT span，Stable `db.system.name=postgresql`；Upstash HTTP 调用按 HTTP CLIENT 表达，Redis 专项约定尚为 Development，不默认启用。跨 API→Cloud Run 的上下文只经官方 W3C propagator 注入/提取，异步 Queue 用 Link 关联原消息，禁止手写解析。成功/拒绝/依赖错误/超时/取消与最终重试失败分别结束 span 并设最终 status，异常只在处理边界记录一次；日志事件使用稳定小写点分名、关联 TraceId/SpanId，绝不记录 SQL 参数或凭据。运行证据需覆盖成功、失败、超时、重试、采样、日志关联及 dropped telemetry；未接 SDK 前只能以现有结构化日志检查，不能把它替代为 OTel 通过。

## 备选方案与权衡

逐表双写无法保持 D1/Neon 原子性；直接把限速作为 Redis 唯一状态会使过期/故障改变额度；Neon serverless driver 可连接但不复用 Hyperdrive 的连接池。以上方案均不采用，代价是切流需冻结写入并对 PostgreSQL 仓储做完整替换。

## Risks / Trade-offs

- [生产 D1 仍会变化] → 冻结窗口内导出，切流前后双向核对计数与增量；任一差异停止切换。
- [旧持久卷与 D1 语义覆盖未知] → 源归档按字节校验，逐主键/业务身份对账；无法证实等价的记录隔离保全且不激活旧队列，未核对前不宣称全量迁移。
- [约 129 MB 源库与 [Neon 官方说明](https://neon.com/blog/neon-backend-is-ga)的 0.5 GB/项目免费存储额度] → 2026-09-10—22 的 D1 指标样本约 3168 行/日且无自动删除路径；先量实际 PostgreSQL 落盘与索引大小、目标可用额度及增长率。超过额度或不能容纳回滚窗口时停止迁移，不能删历史行凑容量。
- [凭据密文格式和数据库 BLOB 差异] → 字节摘要与解密抽样均通过才允许启用新路径；迁移日志不含秘密。
- [跨进程重投和并发租约] → PostgreSQL 原子事务和条件更新的并发测试；Queue 仅在持久入站成功后 ack。
- [Cloudflare Worker 尚未注入 Hyperdrive 凭据，Upstash REST token 未提供] → 本地合成测试与真实资源创建分离，缺少运行时 Secret 不得宣称生产完成。

## Migration Plan

1. 对 PostgreSQL schema/迁移、仓储实现及合成数据做 RED-GREEN-REFACTOR；保持现有 D1 线上运行。验证 API 单元/集成、类型、构建和不变量。
2. 只读检查 D1、旧 PG/Redis 卷的覆盖、差异、队列积压与凭据可用性；确认 Neon/Upstash 服务商额度及运行时凭据。在隔离 schema 试迁完整快照及旧卷差异，核对逐表、关联、摘要与解密结果；身份不明队列仅归档。
3. 制作可恢复的 D1 冻结快照并复核旧卷归档；冻结写入、等待租约、执行正式导入与 shadow 验证。任一验收失败恢复旧路径并保留现场。
4. 配置 Hyperdrive 和 Upstash REST Secret；部署 API/Cloud Run worker；在受控真实来源运行一批并核对外部副作用、重试和回退演练。观察期内旧 D1 只读保留。

## 需求到设计追踪

REQ-001 → DES-001/002/004/005/006；REQ-002 → DES-003/005；REQ-003 → DES-001/004/006/007。

## Open Questions

用户已提供 Neon 与 Upstash Redis 协议连接信息，但尚未配置运行时 Secret；Cloudflare API 使用 Upstash 所需的 REST URL/token、Neon 实际可用额度和生产切流窗口仍需取得并实测。这些只影响执行时机，不改变上述数据所有权或实现边界。
