# Cloud Run ima 验收

日期 2026-10-09；对象为当前 checkout、现有 asia-east1 Worker 的 ima-root-1009 revision 及同镜像单次对账 Job；状态：通过。输入：[proposal.md](proposal.md)、[design.md](design.md)。

## 验收范围

ima 云端配置、跨实例完成记录、自动月份目录、已授权的 Inoreader 登录恢复和本次 4 篇镜像对账；排除历史 uncertain 队列重放和其它来源登录问题。

## 准入条件与退出条件

准入：对应切片设计校验通过，真实目标和权限明确。退出：项目门禁通过，生产镜像/Secret 固定版本核对，实际成功事件及 ima 读回；仅 Ready 不满足退出条件。

## 需求追踪矩阵

| 需求 | 标准 | 用例 | 证据 | 结果 |
| --- | --- | --- | --- | --- |
| REQ-001 | AC-001 | TC-001 | Cloud Logging 17:39 的 4 次镜像成功、ima 正文与 Git 原文独立读回 | PASS |
| REQ-002 | AC-002 | TC-002 | 聚焦测试及真实远端标记更换镜像实例零远程请求 | PASS |
| REQ-003 | AC-003 | TC-003 | 根目录由不存在变为唯一 202610、完整分页及 ads2 刷新读回 | PASS |

## 验收用例

- TC-001 / P0：有效 Secret 且目标知识库唯一；恢复已授权的 Inoreader 后正常增量采集，再用用户批准的同镜像单次 Job 补本次建目录失败的 4 篇；预期 Git 原文保持、ima 正确月份目录含正文和来源、成功日志；记录 revision 及事件时间，不记录秘密和一次性业务内容。
- TC-002 / P0：隔离合成文章、共享状态 Map、两个独立镜像实例；首轮上传完成后更换临时目录再镜像；预期第二实例零 ima/COS 请求；拒绝状态保存时预期无完成事件。旧本机测试继续通过。
- TC-003 / P0：已授权的 ima 网页会话、完整根目录列表；聚焦测试使用合成月份，真实 Cloud Run 仅为本月按需创建并独立读回；目录已存在不重复创建，冲突与失败阻止上传，不删除用户数据。

## 执行记录

2026-10-09 基线：`npm run test --workspace @inbox/worker -- tests/ima-article-mirror.test.ts`，9/9 通过；仅证明既有逻辑，无新行为验收结论。生产只读已确认 ima disabled、凭据缺失，本机官方认证成功，202610 目录缺失。

- TC-001：Secret 3 逐字节读回，新 revision inbox-server-worker-ima-root-1009 镜像固定为 sha256:d19a8ace5dd730165ee8e1d19626267de143bbf6fa8296571484f4d7e64b53d7，实际挂载版本 3，100% 流量、主地址 readyz 200。Inoreader 新会话经现有加密导入接口保存并独立读回相等，17:24 正常增量 collect-source 成功。首版 4 篇 Git 已写入但建目录失败；对账和零写入 dry-run 后用户明确批准仅补镜像。同镜像 Cloud Run Job inbox-ima-reconcile-20261009-wlvgd 在 17:39:49 Completed=True、succeededCount=1；Cloud Logging 17:39:30 至 17:39:45 有 4 次 article.ima_mirror.succeeded，17:39:46 article.ima_recovery.succeeded articles=4、queueReplayed=false。独立 get_media_info 下载内容与 renderImaMarkdownCopy(Git 原文) 摘要 4/4 一致，含原标题、正文与来源。
- TC-002：聚焦测试跨实例共享 Map、状态写拒绝及旧本机标记通过；生产远端完成标记 4/4 的原文摘要、知识库摘要和完成时间正确，对账状态 verifiedArticles=4。用另一镜像实例、全新未使用的临时目录、真实控制面状态及禁止远程请求的 fetcher 再处理这 4 篇，ima/COS 调用 0，验证跨进程跳过；没有重启生产服务或重放队列。
- TC-003：首版真实写入复现 code 51，17:28 RED 测试 3 failed/12 passed，当前官方 root path 确认 folder_id 等于网页知识库 ID；修正后 17:29 聚焦 27/27、Worker 全量 167/167。Cloud Run Job 无预建目录，自动创建后 OpenAPI 完整分页根目录唯一 202610，目录内文章 4/4；ads2 刷新后可见唯一目录。创建拒绝、重复目录、未确认创建、未知同名文章和已存在目录均有聚焦覆盖。
- 门禁：最终 npm test 388 passed/9 skipped、npm run typecheck 与 npm run build 通过；Python ruff/mypy 通过，非 E2E pytest 318 passed/1 skipped/8 既有 warnings。TDD 命令与分阶段结果见当日 Changelog。

## 未执行项与阻塞项

无阻塞项。通用 Python/browser E2E 未执行；本轮真实浏览器范围仅 ima 与 Inoreader。未人为制造新收藏或等待修正版下一轮自然新增文章；实际证据为正常 Inoreader 采集与同镜像 Cloud Run Job 对实际 4 篇原文的镜像归档，不能表述为修正版主服务已经处理了一篇后续自然新增文章。

## 残余风险与发布建议

导入成功后写标记失败可能产生 uncertain，继续人工对账。当前 4 个首版 uncertain 队列记录保留失败审计，业务已由镜像完成标记和专用对账状态证明完成；没有重置其状态。网页建目录登录态未来过期需刷新；现有单实例/串行边界不支持未经协调的扩容。单次 Job 不含计划任务、自动重试为 0，保留执行记录。

## 验收结论

通过：3 个需求的对应实现、聚焦验证和真实云端镜像证据满足本次范围；Inoreader 真实采集与 Cloud Run 自动目录、4 篇正文及远端完成标记读回均通过。主服务后续自然新增文章仍按上述未执行范围单独报告。

## 覆盖统计

3 个需求映射 3 个标准和 3 个用例；执行 3/3，PASS 3/3。成功、依赖拒绝、名称冲突、状态写失败、旧本机兼容与跨实例跳过均已覆盖。

## 实现核对

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| 完整性 | 范围内实现与验证完成 | 3 个新增 Requirement、6 个 Scenario，TDD/门禁/生产对账任务均有证据 |
| 正确性 | 无 CRITICAL 或 WARNING | ima-article-mirror.ts 的持久标记及唯一目录确认、main.ts webhook 接线、config.ts 三认证头及独立网页 ID；对应旧兼容/冲突/失败测试通过 |
| 一致性 | 遵从当前设计 | 复用现有 Control Plane、fetch 和加密导入，不新增依赖/schema；安全失败与人工对账边界保留 |

GitNexus index-only 刷新基于任务开始的 HEAD；调用图为 lower-bound，不能据空调用者推导无影响。最终 detect_changes 给出 HIGH（配置与 Worker run），已报告；真实 diff 的代码/测试仍为 5 个文件，6 条受影响流程已结合源码核对，CosCredential、findUniqueKnowledgeBase、imaRequest 被 hunk 包含但内容未修改。docs-manager 无 error，8 个既有 warning 为旧标题级别或其它已归档 change 的旧链接，未扩大修复范围。完整 OTel 合规和主服务后续自然新增文章未作为通过结论。
