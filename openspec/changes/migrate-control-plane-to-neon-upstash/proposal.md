## Why

用户已指定以 DBX free 分组中的 Neon PostgreSQL 与 Upstash Redis 作为云端数据目标；当前 Cloudflare API 的持久任务、凭据、操作历史和收件箱仍以 D1 为权威，Cloud Run worker 也只经 API 使用这些状态。仅替换 worker 的连接配置不会让目标数据库承载业务数据。

## 背景与问题

`apps/api/wrangler.jsonc` 绑定 D1 和 Cloudflare Queue；`control-plane.ts`、`queue-inbox.ts`、`operations.ts` 等通过 D1 事务协调任务、租约、效果与恢复。DBX 已只读确认 Neon PostgreSQL 18.6（`dbx`）和 Upstash Redis `PING` 可用；用户已提供数据库连接信息，但尚未注入运行时 Secret，Upstash Redis 协议凭据也不能直接充当 Cloudflare REST token。Neon `public` 当前只有历史连接检查表。DBX 的 free 分组不等同于服务商免费额度保证。

## What Changes

- **BREAKING**：拟将 API 的权威持久状态及收件箱整体从 D1 移到 Neon，以单一 PostgreSQL 事务保留任务、效果、恢复信封和重放的不变量；Cloudflare Queue 暂留投递通道。
- 将适合短期过期的限速/在线计数放到 Upstash，并证明原有原子性与延期语义；不把已确认任务、凭据或恢复材料只存 Redis。
- 建立 PostgreSQL 版本化 schema、合成数据验证、全部历史 D1 数据核对、切流和回退步骤；用户已确认完整迁移，实际执行仍以凭据齐备、安全预检和可恢复备份为前提。
- 将旧 Docker PostgreSQL/Redis 持久卷纳入全量数据边界；与 D1 无法确认等价的历史行和队列项须可恢复地保留，不得仅因 D1 行数更多就丢弃。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `cloudflare-application-runtime`：将 D1 权威持久化与版本迁移契约改为 Neon PostgreSQL，并加入 Upstash 临时状态与可核对切流边界；既有 API、Queue 消息和业务幂等语义保持。

## Impact

影响 API 的数据库绑定、schema/migration、控制面、收件箱、运维接口、历史导入/测试及 Cloudflare 部署配置；Cloud Run worker 的 HTTP 控制面契约原则上保持。Neon/Upstash 凭据只经运行时 Secret 注入，不写入仓库、日志或文档。目标 GCP 项目为 `fullstack-fastapi-0923`、区域 `asia-east1`；切流前需先完成隔离验证。

## 范围与成功标准

版本 1；状态：完整迁移范围已于 2026-09-23 确认。目标是 Cloud Run 迁移后 D1 不再是权威业务数据源，D1 与旧持久卷中仍需保留的全部历史记录和长期状态由 Neon 承载，Queue 重投、限速延期和死信重放仍无丢失与重复副作用。REQ-001：Neon 持有全部长期状态与历史记录，关键跨表更新保持原子；REQ-002：Upstash 只持有可重建短期状态，限速语义不变；REQ-003：真实切流须先完成各持久源的覆盖/差异、行数/主键/不变量核对、shadow 验证和回退演练。

## 验收标准

- AC-001：合成并发、失败与重试用例保持既有不变量。
- AC-002：Redis 故障不导致已确认任务丢失。
- AC-003：切流前后核对报告一致且失败时旧 D1 仍可作为回退来源。

## 需求覆盖检查

REQ-001→AC-001/003；REQ-002→AC-001/002；REQ-003→AC-003。

## 非目标与依赖

用户已明确确认全部数据迁移，含历史记录；旧 PG 的 `article_archive_events`/`sync_jobs` 与 D1 快照存在 97 个旧侧独有主键，旧 Redis 还有 35 个无 TTL 的队列元素，是否为语义上已迁移的副本尚未证明。运行时连接仍依赖 Neon 的当前 PostgreSQL 凭据及 Upstash 的 REST 凭据，尚未配置所需运行时密钥。Cloudflare/Google 部署、账号凭据提取和费用配额须独立核对；不得用 DBX 连接成功替代运行时连通与迁移验收。
