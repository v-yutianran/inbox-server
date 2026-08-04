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
