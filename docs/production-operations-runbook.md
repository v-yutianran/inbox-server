# 生产运维就绪手册

## 目的与范围

本文面向 inbox-server 的发布、值守和故障处理人员，提供 Cloudflare API/Console 与 Sealos Worker 的稳定操作入口。需求和阶段性设计仍以 OpenSpec change `improve-production-operations-readiness` 为准；本文只维护可重复执行的长期操作方法。

本手册不授权生产部署、回滚、真实 DLQ 重放、数据删除、真实数据恢复或旧资产删除。执行这些动作前，必须单独取得对应授权并保存脱敏证据。

## 核心结论

- Console 与 API 运行在 Cloudflare；headed Playwright Worker、mihomo 和 WARP 运行在 Sealos 北京区 `bja`、命名空间 `ns-tbs948af`。
- Worker 保持单副本。浏览器登录态、文章归档和外部副作用尚未满足多副本准入条件。
- D1 是任务、DLQ、重放审计和运维指标的事实源；Cloudflare Queues 只负责传输。
- 发布只接受 Git commit、Cloudflare version/deployment、D1 migration、Sealos revision 和三容器镜像 digest 等不可变引用。
- 初始告警阈值是候选值。连续 14 天基线完成前，不把它们视为最终 SLO 或自动处置依据。

## 访问与认证边界

运维 API 使用请求头 `X-API-Key`。`ADMIN_API_KEY` 未配置时，管理端点返回 `503`；配置错误时返回 `401`。管理 Key 只能由运行环境 Secret 注入，不得写入 manifest、发布证据、日志、Console 构建产物或仓库。

以下示例只从当前 shell 环境读取 Key，不打印 Key：

```zsh
curl --fail-with-body \
  -H "X-API-Key: ${INBOX_ADMIN_API_KEY:?missing INBOX_ADMIN_API_KEY}" \
  "https://inbox-server-api.yutianran.cn/api/operations/health/components"
```

Worker 内部端点使用 `Authorization: Bearer <WORKER_SERVICE_TOKEN>`，不得与管理 Key 复用。

## 日常只读检查

### Worker 探针

Worker 在容器端口 `8080` 暴露：

- `GET /healthz`：进程活性。主循环超过 90 秒没有推进或生命周期失败时非 200。
- `GET /readyz`：接单就绪。Worker 必须处于 `ready`，且全部必需组件为 `ready`。

组件状态统一为 `starting`、`ready`、`degraded`、`stopping` 或 `failed`。当前组件包括 `browser`、`mihomo` 和 `warp`；任何必需组件未就绪时，新任务应延期而不是继续领取外部副作用。

Sealos 静态探针定义位于 `deploy/sealos/worker-staging.yaml`。只读检查示例：

```zsh
kubectl --context <sealos-context> -n ns-tbs948af get deployment,pod
kubectl --context <sealos-context> -n ns-tbs948af describe deployment inbox-server-worker-staging
```

本机没有目标 Sealos kubeconfig 时，不得用 OrbStack context 的失败推断生产故障。

### 运维 API

所有以下端点均需 `X-API-Key`：

| 端点 | 用途 |
| --- | --- |
| `GET /api/operations/overview` | Console 总览与 Worker 状态 |
| `GET /api/operations/health/components` | API、Worker 与依赖组件健康 |
| `GET /api/operations/queue/summary` | 可执行、延期、处理中、不可执行及最老年龄 |
| `GET /api/operations/dlq/consistency` | DLQ 与任务/envelope/重放记录一致性分类 |
| `GET /api/operations/metrics?windowHours=24` | 当前值、趋势、候选阈值、采集时间和部署版本 |
| `GET /api/operations/retention/report?retentionDays=30` | 只读保留候选报告，不删除记录 |

## 队列、DLQ 与重放

### DLQ 分类

`dlq/consistency` 的分类是互斥的：`matched`、`historical_migration`、`missing_envelope`、`orphan_dlq`、`integrity_anomaly`、`dead_without_dlq` 和 `already_replayed`。先解释分类，再决定是否重放或修复；不得根据 DLQ 总数直接批量重放。

### 重放流程

1. 调用 `POST /api/operations/replays/plan`，只提交 `jobId` 与全新 `idempotencyKey`。
2. 保存返回的 `planHash`、校验结果和 D1 状态版本；此步不发布任务。
3. 再次确认目标、外部副作用和授权。
4. 只有取得真实重放授权后，调用 `POST /api/operations/replays/execute`，提交相同字段、`planHash` 和 `confirm: true`。
5. 若状态在两步之间变化，接口返回 `409 stale_plan`，必须重新生成计划。

禁止绕过 dry-run、复用不相关的 `idempotencyKey`、重放 `uncertain`/已完成任务或在证据中保存 payload、密文和凭据。

## 事件与指标目录

### 稳定事件

| 事件 | 产生边界 | 说明 |
| --- | --- | --- |
| `worker.lifecycle.ready` | Worker 编排 | 浏览器、mihomo、WARP 和主循环进入可接单状态 |
| `worker.lifecycle.stopped` | Worker 编排 | 收到停止信号并完成优雅退出 |
| `worker.lifecycle.failed` | Worker 编排 | 生命周期启动或运行失败 |
| `worker.loop.failed` | Worker 编排 | 后台循环异常退出 |
| `worker.heartbeat.failed` | Worker 心跳 | 心跳写入失败 |
| `worker.job.succeeded` | 任务 IO 边界 | 任务与外部副作用成功 |
| `worker.job.deferred` | 任务 IO 边界 | 任务无损延期 |
| `worker.effect.busy.deferred` | effect 边界 | 幂等 effect 正在处理，任务延期 |
| `worker.job.retryable_failed` | 任务 IO 边界 | 可重试失败，消耗失败预算 |
| `worker.job.dead_lettered` | 任务 IO 边界 | 真实失败达到上限并进入 DLQ |
| `worker.job.uncertain` | 任务 IO 边界 | 外部结果不确定，禁止自动重放 |
| `worker.job.replay_validated` | API 控制面 | 重放 dry-run 校验完成 |
| `worker.job.replay_published` | API 控制面 | 经确认的重放发布成功 |
| `worker.job.replay_rejected` | API 控制面 | 重放被策略拒绝 |
| `article.extract.direct.succeeded` | 文章归档 | Defuddle 直接提取成功 |
| `article.extract.direct.rejected` | 文章归档 | 直接提取未通过正文验收，准备浏览器兜底 |
| `article.extract.browser.succeeded` | 文章归档 | headed Playwright 兜底后 Defuddle 提取成功 |
| `article.extract.failed` | 文章归档 | 两条提取路径都失败 |
| `article.archive.failed` | 文章归档 | 归档写入或交付失败 |
| `operations.metrics.captured` | API 指标采集 | 一个十分钟窗口的聚合指标写入 D1 |
| `operations.worker_status.resolved` | API 总览 | 按最新 D1 心跳解析 Worker 状态 |

日志上下文可包含 `deploymentVersion`、`jobId`、`leaseId`、`itemKind`、`source`、`destination`、`outcome` 与 `durationMs`。不得包含 Authorization、Cookie、Token、Password、Secret、文章正文、浏览器 state 或 envelope ciphertext。

### 聚合指标

| 指标 | 含义 | 候选阈值 |
| --- | --- | --- |
| `api.availability` | API 指标采集成功信号 | 14 天后确定 |
| `worker.heartbeat_age_seconds` | 最新 Worker 心跳年龄 | `> 90` 秒 |
| `queue.executable` | 当前可执行任务数 | `> 100` |
| `queue.deferred` | 当前延期任务数 | 观察趋势 |
| `queue.oldest_executable_age_seconds` | 最老可执行任务年龄 | `> 600` 秒 |
| `worker.backlog` | Worker 心跳上报的积压 | 观察趋势 |
| `dependency.browser.ready` | 浏览器就绪，1 为就绪 | `< 1` |
| `dependency.mihomo.ready` | mihomo 就绪，1 为就绪 | `< 1` |
| `dependency.warp.ready` | WARP 就绪，1 为就绪 | `< 1` |
| `job.result.<status>` | D1 任务状态计数 | 观察趋势 |
| `article.extraction.<outcome>` | 直接/浏览器提取结果计数 | 观察比例与失败趋势 |
| `worker.job.<outcome>` | Worker 处理结果累计计数 | 观察成功、延期、失败、DLQ 和不确定结果 |

Console 必须同时展示当前值、趋势、阈值状态、`capturedAt` 和 `deploymentVersion`。候选阈值只用于观察；告警渠道、最终 SLO 和错误预算需在 14 天基线后批准。

## 数据保留

保留报告覆盖心跳、完成任务、envelope、DLQ、重放审计和 effect。查询只输出总量、候选量、最老/最新时间及幂等风险，且不得删除数据。

在最终保留期和真实清理授权批准前：

- 允许运行相同参数的只读报告并保存脱敏摘要。
- 禁止执行 `DELETE`、压缩历史表或移除 envelope/effect/replay 审计。
- 禁止用生产数据做试验性恢复；恢复演练默认使用隔离副本。

## 可重复发布与回滚

唯一发布编排入口是根 workspace 的 `release` 脚本：

```zsh
npm run release -- plan --manifest <release-manifest.json> --action apply
npm run release -- apply --manifest <release-manifest.json> --dry-run
npm run release -- apply --manifest <release-manifest.json> --confirm <planHash> --evidence <new-evidence.json>
npm run release -- plan --manifest <release-manifest.json> --action rollback
npm run release -- rollback --manifest <release-manifest.json> --dry-run
npm run release -- rollback --manifest <release-manifest.json> --confirm <planHash> --evidence <new-evidence.json>
```

`--dry-run` 与实际执行共享同一 `planHash`，但不调用任何外部命令。实际执行必须提供完全相同的 `planHash`；证据文件使用独占创建，禁止覆盖旧证据。`--compensate` 会改变外部状态，只能在已单独取得回滚授权时使用。

发布顺序固定为：预检 → 备份证据 → expand migration → API → Console → Sealos manifest 与 rollout → 隔离 canary → 稳定窗口验证。任一步失败立即停止；D1 不做破坏性 down migration，应用回退依赖 expand/contract 兼容窗口。

release manifest 必须满足：

- `sourceCommit` 与 Console commit 是完整 40 位 Git SHA。
- API 使用 Cloudflare 不可变 version，Console 使用已构建 artifact。
- Worker、mihomo、WARP 镜像均为南京大学 GHCR 代理的 `@sha256:<digest>`，禁止 tag。
- Sealos context 不能是 `orbstack`、`docker-desktop`、`minikube` 或 `kind-*`。
- Secret 只保存名称和版本引用，禁止保存原值。

## 发布前后检查清单

### 发布前

- [ ] 生产部署/回滚授权与目标范围已记录。
- [ ] 工作区、分支、`sourceCommit` 和 release manifest 一致。
- [ ] 全量 typecheck、test、build 通过。
- [ ] D1 migration 为 expand/contract，旧版本仍能读写。
- [ ] Cloudflare version/deployment、三镜像 digest、Sealos revision 与 Secret version ref 已冻结。
- [ ] `apply --dry-run` 的 `planHash` 已复核。
- [ ] 备份证据存在且恢复路径已知。

### 发布后

- [ ] API 和 Console 返回预期版本。
- [ ] Sealos rollout 完成，副本仍为 1。
- [ ] `/healthz`、`/readyz`、D1 心跳和组件健康一致。
- [ ] 隔离 canary 通过且没有访问真实外部目标。
- [ ] 新增 DLQ、最老任务年龄和 `uncertain` 数没有异常增长。
- [ ] 脱敏发布证据已保存，未包含 Secret、Cookie、正文或密文。

## 禁止事项与处理路径

- 禁止用可变 tag、未冻结构建目录或本机 Kubernetes context 发布；先修正 manifest 并重新生成 plan。
- 禁止在没有 14 天基线和保留期批准时清理 D1；只运行 retention report。
- 禁止自动重放线上 DLQ；先分类、生成 plan、取得授权，再以同一 `planHash` 执行。
- 禁止把 Worker 扩到多副本；先完成租约、幂等、归档、登录态和故障转移验收，并新建独立 ADR。
- GitHub Actions 资金问题恢复前，不触发、重试或等待工作流；本地门禁结果不能冒充 CI 结果。

## 维护入口

- 规范需求与阶段任务：`openspec/changes/improve-production-operations-readiness/`
- 长期架构决定：`docs/adr/README.md`
- 代码质量历史记录：`docs/optimization-plan.md`，不作为当前云端运行事实来源
- 当前总路线：`roadmap.md`
