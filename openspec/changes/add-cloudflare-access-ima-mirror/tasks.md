## 1. RED：锁定认证与镜像契约

- [x] 1.1 为 Console 锁定态的可访问结构、文案和现有 API Key 行为补充失败测试，并记录 RED 命令与原因
- [x] 1.2 为 ima 禁用、Git 成功后调用、失败重试、完成标记和脱敏日志补充失败测试，并记录 RED 命令与原因

## 2. GREEN：实现 Console 与 Cloudflare Access

- [x] 2.1 最小调整 `App.tsx` 与样式，形成滴答式克制登录卡并让聚焦测试通过
- [x] 2.2 配置 Access application、Google/One-time PIN IdP、允许策略与 login design，并保留 API Key 第二层授权

## 3. GREEN：实现 ima Markdown 镜像

- [x] 3.1 新增 ima OpenAPI/COS 适配器、配置解析和本地原子完成标记
- [x] 3.2 在 Git 归档成功后组合可选镜像，并复用现有重试/DLQ 边界
- [x] 3.3 更新 Sealos 模板的 Secret 引用和非秘密配置，不提交凭据

## 4. REFACTOR：收敛边界与回归

- [x] 4.1 收敛类型化错误、超时、低基数 reason code 与敏感字段过滤并保持聚焦测试通过
- [x] 4.2 运行 Console/Worker 聚焦测试、全工作区 test/typecheck/build 与 OpenSpec 校验

## 5. 线上验收与交付

- [ ] 5.1 轮换 ima Key，写入 Sealos Secret，先用合成 Markdown 验证 ima 导入和重投幂等
- [x] 5.2 验证 Access 匿名重定向、Google/邮箱登录入口和登录后 API Key 解锁；记录未自动完成的人工项
- [x] 5.3 更新根与当日 Changelog、ADR/运行手册，运行 GitNexus detect changes 和秘密扫描
- [x] 5.4 精确 commit、普通 push 并创建或复用 PR，不 merge、不部署未授权版本

## 实施证据

- RED：`npm run test --workspace @inbox/worker -- --run tests/article-archive.test.ts`，19 项中新增 2 项按“未调用 mirror / mirror 失败仍返回 ok”失败；Git 失败零镜像用例直接通过。
- GREEN：同命令 19/19；`npm run test --workspace @inbox/worker -- --run tests/ima-article-mirror.test.ts` 6/6；配置与三文件聚焦测试合计 29/29。
- Console RED：`npm run test --workspace @inbox/console -- --run src/App.test.tsx` 仅新锁定页契约失败；GREEN 7/7，既有 sessionStorage 与 API Key 行为保持通过。
- 全量：先构建 `@inbox/domain` 后 `npm test`（API 66、Console 15、Worker 120、Domain 8、Release 30）、`npm run typecheck`、`npm run build` 全通过。
- Python 兼容层：ruff 通过，pytest unit/integration 261 passed / 9 baseline warnings，mypy 103 source files 无问题。
- 规范与文档：当前 change strict valid，三份设计 gate valid，YAML 解析与 `git diff --check` 通过；docs audit 无 error，4 条 warning 均为既有已归档 OpenSpec 链接。
- 全库 OpenSpec 基线：既有 `move-article-archive-to-raw` change 因缺少 3 个后来新增 Scenario 而失败，不由本 change 修改。
- 线上 Access：正式域名匿名请求返回 302 到 Cloudflare Access，最终登录页返回 200 且包含 Google 与邮箱入口；应用仅允许指定邮箱，两个 IdP 均已绑定。浏览器工具不可用，未自动输入真实账号或验证码；改以 Console API Key 契约测试 10/10，加线上受保护端点验证完成双层授权：Keychain 轮换后 Key 返回 200，无 Key 与错误 Key 均返回 401。Cloudflare Secret Change version `b3f6f991-316d-490f-9fac-e4579b7f0131` 已 100% 生效，Console 匿名访问仍为 302，API `healthz` 为 200。
- 线上 Worker：南京大学 GHCR 代理与源站 tag digest 一致；Sealos revision `27108f2d0df2a9a150f1fadfc6ce151059c60764`、三容器 Ready、`healthz`/`readyz` 200。ima 开关仍为 `false`，runtime Secret 尚无 ima 键。
