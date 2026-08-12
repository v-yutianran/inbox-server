## Context

动机见 [proposal.md](./proposal.md#why)，行为契约见 [console-access-authentication](./specs/console-access-authentication/spec.md) 与 [article-markdown-archive](./specs/article-markdown-archive/spec.md)。Console 当前由 Cloudflare Pages 提供静态资源，管理 API 仍以 `X-API-Key` 授权；Sealos 单副本 headed Worker 在 Git 仓库中完成文章权威归档。Cloudflare 账号已有 Google 和 One-time PIN IdP，ima OpenAPI 使用 Client ID/API Key 并通过临时 COS 凭据上传文件。

## Goals / Non-Goals

**Goals:**

- 不改变管理 API 合同，为 Console 增加人的身份登录与滴答式克制视觉。
- 保持 Git `raw/article` 为唯一权威归档，并在其成功后增加可重试的 ima 镜像。
- 复用当前文章任务的幂等、重试和 DLQ 边界，避免引入第二套队列。
- 把凭据、文章正文、完整 URL 和临时 COS 密钥排除在遥测之外。

**Non-Goals:**

- 不建立多租户用户账户、会话数据库或角色权限系统。
- 不用 Cloudflare Access token 替代管理 API Key。
- 不从 ima 反向同步或修改 `raw/article`，不迁移历史文章。
- 不承诺 ima 外部系统的 exactly-once；以重名预检和本地完成标记实现可控的 at-least-once。

## Decisions

### 1. Cloudflare Access 前置身份，API Key 保留为操作授权

Pages 域名前的 Access application 允许 Google 与 One-time PIN IdP，Access 登录设计负责品牌和入口视觉；进入 Console 后仍显示本地 API Key 解锁卡。这样不需要更改 Cloudflare API、D1 或 Worker 的授权协议，也避免把管理 Key 交给身份提供商。备选的 Clerk/Auth.js 会引入用户存储、token 校验和后端迁移，超出单租户运维 Console 的必要范围。

### 2. Console 只重塑锁定态，不新增伪造的 Google/邮箱按钮

Google 与邮箱入口由 Cloudflare Access 托管，React 页面只在 Access 成功后出现。因此 Console 锁定态采用单主操作、持久标签、明确错误与辅助说明的滴答式卡片，不重复渲染无法直接执行的 IdP 控件。Cloudflare login design 使用同一绿色主色、暖白背景与简洁文案，形成跨边界一致性。

### 3. ima 是 Git 成功后的应用层镜像步骤

`createArticleArchiver` 继续先调用 `ArticleRepository.save`；返回成功后才调用可选 `ArticleMirror.mirror`。镜像接口接收已渲染 Markdown、文件名与规范化 URL，不访问浏览器、Git 或队列。ima 失败抛出类型化错误，让现有 job handler 重试；Git 仓库的原始 URL 幂等检查保证重试不生成第二个文件。

### 4. ima 适配器直接实现官方六步上传契约

适配器依次执行：知识库定位、同名预检、创建媒体、使用临时 COS 凭据 PUT 原始 Markdown、添加知识、记录完成。仅使用 Node 标准库和现有 `undici`，不把本地下载 Skill 复制到生产包。知识库 ID 在启动后按名称解析并缓存；名称必须唯一，否则 fail closed。重名时视为已镜像，仅当同名条目可由本地完成标记或可验证列表确认；不自动改名制造重复。

### 5. 镜像完成状态使用本地不可逆摘要文件

在现有持久卷的文章归档状态目录保存 `sha256(normalizedSourceUrl)` 完成标记，内容只含 ima knowledge ID、文件内容摘要和完成时间，不含原始 URL、文章正文或凭据。写入采用临时文件加原子 rename。这样在 Git 已成功、Queue 重投时可跳过 ima，且不需要修改 Cloudflare D1 schema。备选的只靠 ima 文件名重名无法区分同标题不同 URL。

### 6. 可观测性只记录边界结果和稳定原因码

新增 `article.ima_mirror.succeeded` 与 `article.ima_mirror.failed` 事件；属性仅包含固定 provider、阶段、结果、reason code 与耗时桶。HTTP client 使用既有 `fetch` 自动/上层 trace，不重复创建同一网络操作 span；W3C Trace Context 随现有异步上下文传播。禁止记录邮箱、Client ID、API Key、COS 凭据、文件名、文章内容、完整 URL、knowledge ID 或响应 body。

## Risks / Trade-offs

- [Access 保护 `pages.dev` 可能影响公开健康探测] → 只保护 Console host，API 健康端点保持独立；部署后分别验证匿名重定向和 API 健康。
- [ima OpenAPI 或 Skill 契约变化] → 封装单一适配器、固定请求超时与 reason code；失败进入现有重试/DLQ，不污染 Git。
- [Git 已成功而 ima 持续失败会使任务对外失败] → Git 幂等保证重试安全；Console/DLQ 明确区分 ima 阶段，修复凭据后可重放。
- [同名文件无法证明内容一致] → 以本地 source 摘要完成标记为主要幂等依据；首次碰到无标记同名时 fail closed，不静默覆盖或自动改名。
- [Cloudflare 托管登录页可定制范围有限] → 以 login design 能力对齐颜色、logo 与文案；具体控件布局服从 Access 的可访问实现。

## Migration Plan

1. 在隔离 worktree 完成 OpenSpec、测试与实现，使用模拟 ima server 验证全部失败分支。
2. 部署前轮换已暴露的 ima API Key，把新凭据写入 Sealos Secret；先以镜像 disabled 发布 Worker。
3. 配置 Cloudflare Access application、Google/One-time PIN IdP、允许策略和 login design；匿名验证重定向，登录后验证 API Key 解锁。
4. 启用 ima 镜像，先上传一份合成 Markdown 到目标知识库，验证完成标记、重投跳过和日志脱敏，再运行一条真实文章链路。
5. 回滚时先关闭 ima 镜像，再删除/停用 Access application；回滚不删除 ima 已导入知识或 Git 文章。

## Open Questions

无。新 ima Key 必须在生产验证前完成轮换；这是部署门槛而非设计问题。
