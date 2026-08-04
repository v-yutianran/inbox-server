## 1. RED：建立失败用例

- [x] 1.1 为同数量不同 key、重叠窗口、无新 key、20 轮上限和默认数量停止行为增加 `scrollExtract` 失败测试
- [x] 1.2 把通知期望改为“已入队”，并确认现有实现下测试失败

## 2. GREEN：最小实现

- [x] 2.1 为 `scrollExtract` 增加可选稳定 key 累积策略，并仅在 Inoreader 调用中启用
- [x] 2.2 把同步通知中的 dispatch job 数量文案由“发布”改为“已入队”

## 3. REFACTOR：回归与记录

- [x] 3.1 运行 Worker 定向及全量测试，确认 YouTube/X 默认滚动行为、零新增不通知和单任务通知顺序不变
- [x] 3.2 更新 `CHANGELOG.md`，记录行为变化、可观测事件和验证命令

## 4. 验收与交付门禁

- [x] 4.1 运行 Worker typecheck、build 和仓库级适用验证
- [x] 4.2 补全并校验 `acceptance.md` 的执行证据、覆盖率、未执行项和残余风险
- [x] 4.3 运行 `openspec validate` 与 GitNexus `detect-changes`，确认变更范围后提交并创建 PR

## 5. RED：锁定 SPA 延迟渲染缺陷

- [x] 5.1 更新 design 与 `browser-collect-parity` delta spec，明确 Inoreader 必须等待至少一个可提取 article 就绪，超时必须显式失败，禁止用固定 sleep 或把未就绪误报为零新增
- [x] 5.2 在 collector 调用边界增加失败测试：`document.body` 先出现、article 延迟出现时，现实现返回零条；修复后必须等待并返回延迟出现的稳定 key
- [x] 5.3 增加永不就绪与登录失效用例，断言任务不更新 `baseline:inoreader`、不创建 dispatch job、也不发送同步通知

## 6. GREEN：Inoreader 专用最小修复

- [x] 6.1 新增 Inoreader 专用内容就绪等待，只在 `collectInoreader` 中于登录检查后、`scrollExtract` 前调用；复用现有选择器和 60 秒超时预算
- [x] 6.2 就绪超时后重新检查登录 URL，并抛出可分类的 Inoreader 内容未就绪错误；保留现有 `worker.job.succeeded` / failed 事件和低敏感 summary，不记录标题、URL 或凭据

## 7. REFACTOR：局部与全量回归

- [x] 7.1 复用 Inoreader DOM 选择器，避免等待条件与提取条件漂移；确认 `waitForDocumentBody`、`scrollExtract` 及其它浏览器来源行为没有变化
- [x] 7.2 运行 Worker 定向测试、Worker 全量测试、全 workspace 测试、typecheck 和 build，并更新 `CHANGELOG.md` 的缺陷原因、修复行为及验证命令
- [x] 7.3 运行 acceptance-design validate、`openspec validate fix-inoreader-pagination-notifications` 与 GitNexus compare/detect-changes；任何范围外流程影响均阻断交付

## 8. 生产验收、回滚与交付

- [ ] 8.1 获得生产部署与真实数据复验授权后，记录待部署 HEAD、旧镜像 digest、Worker Ready 状态、基线计数 B0、待处理任务与 DLQ 计数；备份待改源码并先执行部署 dry-run/差异预检
- [ ] 8.2 仅发布并滚动更新 Sealos Worker，核对 source revision、镜像 digest、三个容器 Ready、heartbeat 和浏览器依赖，不修改 Cloudflare API/Console、D1 schema、baseline 或 DLQ
- [ ] 8.3 仅触发一次 Inoreader：预期发现当前 3 条新收藏、`collected=3`、`published=3`、基线变为 B0+3，三个 dispatch job 及其 effect 成功，且只发送一条“已入队”通知
- [ ] 8.4 使用新 run id 再触发一次 Inoreader：预期 `collected=0`、`published=0`，不新增 dispatch、effect、通知或 DLQ，证明去重闭环
- [ ] 8.5 若就绪等待、采集、分发或健康门禁失败，回滚到预检记录的旧镜像 digest，并复核 Worker Ready 与任务领取恢复；不手工回退 baseline，已发生的外部副作用不做自动逆操作
- [ ] 8.6 补全 `acceptance.md` 的实际证据和结论后，按 Git 交付门禁执行 commit、普通 push 和 PR；本任务不授权 merge
