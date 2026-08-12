# Cloudflare Access 与 ima 镜像技术设计门禁

## 关联需求

REQ-001 至 REQ-005 见 `requirements.md`；OpenSpec 行为事实见 `../specs/**/*.md`。

## 当前架构与约束

Console 是 Cloudflare Pages React 应用，API 使用 `X-API-Key`；Sealos Worker 先提取文章再由 Git repository 写入 `raw/article`。不得让 UI 承载业务规则，不得把秘密传到前端或遥测。

## 方案总览

- DES-001：Cloudflare Access 在 Pages 前置，IdP 负责身份，API Key 负责操作授权。
- DES-002：React 仅优化 Access 后的 API Key 锁定态，不伪造 IdP 按钮。
- DES-003：Git save 成功后调用可选 ima mirror port。
- DES-004：ima adapter 实现知识库解析、重名检查、create_media、COS PUT、add_knowledge 和原子完成标记。
- DES-005：所有边界错误映射为稳定 reason code，现有 job handler 负责重试/DLQ。

## 详细设计

领域不变量由 `ArticleMirror` 输入契约与组合顺序表达；I/O 全在 application shell。完成标记以规范化 source URL 的 SHA-256 命名，内容不含业务正文。ima 网络层只接受显式配置和注入的 fetch，便于纯合成测试。

## 接口契约

- `ArticleMirror.mirror({ sourceUrl, fileName, markdown }): Promise<void>`。
- 配置：enabled、clientId、apiKey、knowledgeBaseName、stateDirectory、timeoutMs；只有 enabled=true 才要求完整配置。
- 外部请求仅到 `ima.qq.com` 和 API 返回的 `*.myqcloud.com`，其它 COS host fail closed。

## 验证策略

- RED：Console 语义/UI 测试和 ima adapter/组合测试先失败。
- GREEN：聚焦测试通过；模拟服务覆盖每个 API 阶段和超时。
- REFACTOR：全工作区 test/typecheck/build、OpenSpec、秘密扫描和 GitNexus detect changes。

## 备选方案与权衡

- Clerk/Auth.js：功能过重且需要后端 token/用户模型，拒绝。
- ima 失败忽略：会让“转存一份”静默丢失，拒绝；采用任务失败但 Git 幂等重试。
- 复制下载 Skill：会形成供应链副本，拒绝；按公开契约做最小适配器。

## 需求到设计追踪

| 需求 | 设计 |
|---|---|
| REQ-001、REQ-002 | DES-001、DES-002 |
| REQ-003 | DES-002 |
| REQ-004 | DES-003、DES-004 |
| REQ-005 | DES-004、DES-005 |

## 风险与迁移

部署以 ima disabled 起步，轮换 Key 后做合成导入再启用；回滚先禁用 ima，再移除 Access application，不删除已归档内容。
