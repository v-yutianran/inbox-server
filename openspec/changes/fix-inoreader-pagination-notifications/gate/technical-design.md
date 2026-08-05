# Inoreader 生产复验技术设计

## 文档信息

| 项目 | 内容 |
| --- | --- |
| 变更 | `fix-inoreader-pagination-notifications` |
| 版本 | 1.0 |
| 日期 | 2026-08-05 |
| 状态 | 待生产执行 |
| 需求基线 | `requirements.md` 1.0 |
| 实现基线 | `../design.md`、提交 `96cd3f8a467a148b523037e9c96862084032b7be` |

## 关联需求

覆盖 REQ-001～REQ-007。生产发布与真实数据验收不改变已合并的 collector、通知或控制面契约，只为现有代码建立不可变镜像身份、限定 rollout、运行时证据与失败回滚闭环。

## 背景、目标与非目标

代码修复已完成本地测试，但当前 Sealos StatefulSet 仍运行旧 Worker digest。目标是把同一提交构建为公开 GHCR 镜像，通过南京大学代理的相同 digest 只更新主容器，并以两次真实 Inoreader 运行证明非零采集和去重闭环。非目标包括 Cloudflare API/Console/D1 变更、sidecar 更新、baseline/DLQ 人工操作和外部副作用逆转。

## 当前架构与约束

- 生产对象是 namespace `ns-tbs948af` 中的 StatefulSet `inbox-server-worker-staging`，单副本、`revisionHistoryLimit: 1`。
- Pod 含主容器 `inbox-server-worker-staging`、Mihomo `mihomo-egress` 和 WARP `warp-egress`；三者共享网络命名空间，主容器依赖本地代理端口。
- 主容器从 `Dockerfile.worker` 构建，运行 Chromium、Xvfb、health server 与 queue processor；`/healthz` 证明活性，`/readyz` 证明控制面、浏览器和所需 sidecar 依赖就绪。
- `DEPLOYMENT_VERSION` 由 Pod template annotation `inbox.yutianran.cn/source-revision` 注入，并随 heartbeat 上报控制面。
- Worker、Mihomo、WARP 均以 `ghcr.nju.edu.cn/...@sha256:<digest>` 固定；源 GHCR 为公开包，不使用 imagePull Secret。
- 根 `release-operations` 当前只支持 API、Console、D1、Worker 的整套发布，不能用于本次 Worker-only 授权；调用它会越界。因此本次采用 Kubernetes update path 的精确 strategic merge patch，并保留同参数 server dry-run。
- 集群命令统一使用 `KUBECONFIG=~/.sealos/kubeconfig kubectl --insecure-skip-tls-verify`，禁止 delete。

## 方案总览

1. 只读冻结工具、认证、StatefulSet/Pod、旧三容器镜像、旧 source revision、Ready/heartbeat、B0、任务与 DLQ 计数。
2. 以完整提交 `96cd3f8...` 为构建上下文，构建 `linux/amd64` Worker 镜像并推送公开 GHCR；解析源 registry digest，再验证南京大学代理能解析同一 digest。
3. 生成只含 StatefulSet metadata annotation、Pod template source revision 和主容器 image 的 strategic merge patch；先执行 server dry-run 与差异审查，确认 sidecar、Secret、PVC 和其它字段无变化。
4. 应用同一 patch，等待 StatefulSet rollout，核对实际 imageID、source revision、三个容器 Ready、health、heartbeat、浏览器和 60 秒稳定窗口。
5. 使用两个新 run id 依次触发 Inoreader；每次以控制面权威状态核对 baseline、job、effect、通知和 DLQ 增量。
6. 任一 P0 门禁失败时，用预检冻结的旧主容器 digest 与旧 source revision 生成反向 strategic patch，dry-run 后应用并重验。

## 组件职责与数据所有权

| 组件 | 职责 | 权威状态 |
| --- | --- | --- |
| Docker/buildx | 从目标提交构建并推送 Worker | GHCR manifest digest |
| Sealos StatefulSet controller | 滚动替换单副本 Pod | StatefulSet revision、Pod UID/imageID/Ready |
| Worker health server | 提供 `/healthz`、`/readyz` | 进程内组件状态 |
| Worker control-plane client | heartbeat、claim job、更新结果、baseline 与 effect | Cloudflare 控制面持久状态 |
| Inoreader collector | 等待可提取 article、按稳定 key 去重并返回新增项 | Inoreader DOM + `incremental_baselines` |
| queue processor | 创建 dispatch job、执行 effect、记录结果 | queue jobs 与 worker effects |
| notification formatter | 非零 collect job 发送一条“已入队”同步报告 | notification 记录/发送事件 |
| 部署审计日志与验收文档 | 保存低敏计数、digest、revision、run id 和结论 | 本次任务证据 |

## 详细设计

### DES-001：生产身份与回滚锚点

在任何写动作前读取并记录 StatefulSet generation/currentRevision/updateRevision、Pod UID、三容器 image/imageID、restartCount、Ready、Pod template source revision 和 annotation `originImageName`。同时通过现有控制面接口记录 heartbeat deployment version、B0、未完成 job 与 DLQ 计数。秘密、文章标题、正文和 Cookie 不进入输出。

### DES-002：不可变镜像构建与代理验证

构建命令使用 `Dockerfile.worker`、仓库根 context、`--platform linux/amd64`、提交派生的唯一 tag 和 `--push`。tag 仅用于发布，部署只使用返回的 `sha256` digest。验证顺序为源 GHCR manifest 可匿名读取、南京大学代理用同一仓库路径和 digest 可解析、最终 Pod `imageID` 对应目标 digest。构建失败最多按 sealos-deploy 规则做三次针对性重试，不改 Dockerfile 以外范围；本次预期不需要代码修复。

### DES-003：主容器限定 strategic patch

patch 只包含：

- StatefulSet metadata annotation `originImageName=<target proxy image@digest>`；
- Pod template annotation `inbox.yutianran.cn/source-revision=96cd3f8...`；
- `containers[name=inbox-server-worker-staging].image=<target proxy image@digest>`。

先以 `kubectl patch ... --type=strategic --dry-run=server -o yaml` 验证服务端接受，再将渲染结果与实时对象比较。若差异涉及 `mihomo-egress`、`warp-egress`、env/envFrom、volumes、resources、probes、securityContext 或 replica 数，停止部署。

### DES-004：rollout 与运行时真相

实际 patch 后等待 `kubectl rollout status statefulset/inbox-server-worker-staging`。验收必须同时满足：

- StatefulSet observedGeneration 与 generation 对齐，currentRevision 等于 updateRevision；
- 新 Pod 三个容器 Ready，restartCount 无新增；
- 主容器 spec image、runtime imageID、Pod source revision 和 heartbeat deployment version 均指向目标身份；
- 容器内 `/healthz`、`/readyz` 成功，browser、control plane、Mihomo、WARP 组件状态 ready；
- 初次运行时扫描后等待至少 60 秒再比较，无活动失败事件、Ready 抖动、新重启或重复 traceback。

### DES-005：两次 Inoreader 业务事务

每次通过现有管理接口创建唯一 collect job，不直接调用容器内部函数。第一次运行前冻结 B0、job/effect/notification/DLQ 计数；完成后令实时新增量为 `N`，要求 summary 为 `collected=N/published=N`、baseline=B0+N、存在 N 个成功 dispatch job 与 N 个成功 effect、通知增量为 1 且用户可见术语为“已入队”。第二次用另一 run id，要求 `0/0`、baseline 与所有副作用计数不变。若 `N=0`，只能证明安全零新增与去重，不能把 TC-011 非零路径判为完整通过。

### DES-006：失败回滚

回滚 patch 与 DES-003 同形，只把主容器 digest、`originImageName` 和 source revision 恢复为预检值。回滚前同样执行 server dry-run；应用后重跑 DES-004 的 rollout、Ready、heartbeat、任务领取与稳定窗口检查。baseline 和已经发生的第三方 effect 保持现状，不执行反向数据操作。

### DES-007：本地声明与证据收敛

成功后把生产目标 digest 与 source revision 回填到现有 Worker 部署声明中，保持本地不可变声明与集群一致；只更新与 Worker 主镜像身份直接相关的字段。部署日志、`acceptance.md`、`tasks.md` 和 `CHANGELOG.md` 记录命令类别、时间、计数、digest、run id 与结论，不记录秘密或文章内容。

## 接口契约

### Kubernetes 更新接口

- 目标：`apps/v1 StatefulSet/ns-tbs948af/inbox-server-worker-staging`。
- patch 类型：strategic merge；容器合并键为 `name`。
- dry-run 和实际 patch 内容必须字节一致；实际执行前保存 patch SHA-256。
- 成功：kubectl 退出 0，rollout 完成，DES-004 全部通过。
- 失败：停止后续 Inoreader 运行；若已经改变 Pod template，则进入 DES-006。

### 控制面接口

- 管理调用只使用现有 API key 注入，不写入文件或日志。
- 触发 collect job 时 source 固定 `inoreader`、run id 全局唯一；轮询 job 到终态。
- 查询只暴露 baseline 数量、job/effect/notification/DLQ 的标识、状态、计数和时间，不输出 payload 正文。
- 第二次触发必须在第一次所有 dispatch/effect 已终态后开始，避免并发竞态。

### 健康接口

- 容器内 GET `http://127.0.0.1:8080/healthz` 返回 2xx 代表 liveness。
- 容器内 GET `http://127.0.0.1:8080/readyz` 返回 2xx 且组件均 ready 代表 readiness。
- heartbeat 的 deployment version 必须等于 Pod template source revision。

## 数据、一致性与幂等

- baseline 的唯一所有者是控制面 `incremental_baselines`，collector 只提交 `known + fresh.key` 单调集合。
- dispatch job 与 effect 使用现有稳定 key/幂等约束；验收只计算本次 run 关联增量。
- 部署幂等性由不可变 digest、patch SHA 和 source revision 保证；重复应用相同 patch不产生新业务任务。
- 两次 collect run 串行执行且 run id 不复用。

## 可观测性与安全

- 复用 `worker.job.succeeded/failed`、heartbeat、Kubernetes Events、Pod restart/Ready 和 health 响应。
- 运行时证据仅保留低基数字段；所有 authorization/cookie/password/secret/token 值脱敏。
- 临时 patch 与查询结果只存于精确任务路径或 `/private/tmp`，完成后不纳入提交；部署日志长期保留但不含秘密。
- 禁止 `kubectl delete`、Secret 读取、D1 schema 写入、baseline/DLQ 人工改写。

## 发布、回滚与停止条件

- 写动作顺序固定为镜像 push → patch server dry-run → patch apply → rollout → 稳定窗口 → 第一次 collect → 第二次 collect。
- 镜像身份、patch 范围、rollout、health、heartbeat 或首次业务链路任一失败立即停止；若集群已变更则执行 DES-006。
- 第二次运行失败同样触发运行时回滚，但不逆转第一次已完成的业务副作用。
- 回滚失败、旧 Pod 不能 Ready、任务领取不能恢复或发现范围外差异时，任务结论为阻塞并停止后续写操作。

## 验证策略

- 设计门禁：requirements-design、technical-design、acceptance-design、OpenSpec validate。
- 构建门禁：Worker 定向测试、workspace test/typecheck/build 已通过；部署前复核 Docker/buildx 与目标提交。
- 基础设施门禁：server dry-run、精确差异、rollout、三容器 Ready、imageID/source revision/heartbeat、两次相隔至少 60 秒的运行时扫描。
- 业务门禁：TC-011 两个 run id 的 summary、baseline、dispatch、effect、通知和 DLQ 前后对账。
- Git 门禁：GitNexus detect-changes、精确路径 commit；push/PR/merge 按当前授权单独判定。

## 备选方案与权衡

- **整套 `release-operations apply`**：提供 planHash 和补偿，但必然执行 D1、API、Console，超出本次 Worker-only 授权，拒绝。
- **应用完整 `worker-staging.yaml`**：可保持声明式一致，但可能顺带收敛 sidecar、Secret、resource 或 volume 漂移，范围过大，拒绝作为生产写入口；仅用于只读比较和成功后的本地身份回填。
- **`kubectl set image`**：只改主容器，但无法原子更新 source revision/annotation，运行身份可能短暂不一致；不采用。
- **strategic merge patch**：同时更新三处身份且按容器名合并，范围最小、可 server dry-run 和精确回滚，因此采用。

## 风险、假设与实施交接

- 假设现有 StatefulSet/容器命名与预检一致；任何漂移以实时对象为准并重新生成 patch，不猜测。
- GHCR 代理缓存可能延迟，以 digest 解析和 Pod imageID 为准，不以 tag 或拉取成功单独判定。
- `revisionHistoryLimit: 1` 使 Kubernetes 历史不足以代替显式旧 digest；必须保存预检值。
- 真实 Inoreader 登录态或收藏数量会漂移；登录失效触发失败，数量漂移记录实际 N。
- 无待决策事项；若必须修改 Cloudflare、sidecar、Secret、baseline 或 DLQ 才能继续，立即停止并请求新授权。

## 需求到设计追踪

| 需求 | 设计 |
| --- | --- |
| REQ-001 | DES-001 |
| REQ-002 | DES-002、DES-003 |
| REQ-003 | DES-004 |
| REQ-004 | DES-005 |
| REQ-005 | DES-005 |
| REQ-006 | DES-006 |
| REQ-007 | DES-007 |

所有 P0 需求均有明确设计与停止条件；无未解决阻塞项。
