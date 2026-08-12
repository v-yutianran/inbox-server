# Cloudflare Access 与 ima 镜像验收方案

## 文档信息

- 验收对象：`add-cloudflare-access-ima-mirror`
- 版本：1.0
- 环境：本地合成环境、Cloudflare、Sealos `ns-tbs948af`
- 日期：2026-08-12
- 状态：待执行
- 关联资料：`requirements.md`、`technical-design.md`、`../tasks.md`

## 验收范围

- `REQ-AUTH-001`：匿名访问受保护 Console 时进入 Access，Google 与邮箱验证码均可选。
- `REQ-AUTH-002`：Access 登录后仍需管理 API Key，现有会话存储与错误恢复不变。
- `REQ-AUTH-003`：登录/解锁页面满足键盘、焦点、alert、窄屏和 200% 缩放要求。
- `REQ-IMA-001`：Git 权威归档成功后才执行 ima 镜像；未配置时零请求。
- `REQ-IMA-002`：ima 六步上传、幂等完成标记、重试与日志脱敏符合设计。

## 验收环境与数据

- 自动测试只使用合成 Markdown、模拟 ima/COS 服务和测试凭据。
- Cloudflare 验证使用精确 Console host 与账号现有 Google/One-time PIN IdP。
- Sealos 验证使用 `ns-tbs948af` 中目标 Worker Secret 与单个合成文章，不回放历史真实数据。
- 浏览器 E2E 仅在可用且获得授权的会话执行；不可用时保留人工验证项，不宣称通过。

## 准入条件与退出条件

- 准入：OpenSpec 与三份 gate 文档有效，聚焦测试已建立，生产 Key 已轮换。
- 退出：自动门禁全绿，线上匿名/登录/合成导入证据齐全，秘密扫描无命中。

## 追踪矩阵

| 需求 | 验收标准 | 自动证据 | 线上证据 | 状态 |
|---|---|---|---|---|
| REQ-001 | AC-001 匿名重定向且两种 IdP 可见 | Cloudflare 配置只读断言 | TC-001 | 待执行 |
| REQ-002 | AC-002 无 Key 不请求，有效/无效 Key行为不回归 | Console 单测 | TC-002 | 待执行 |
| REQ-003 | AC-002 语义、焦点、alert、响应式可用 | Console test/typecheck/build | TC-003 | 待执行 |
| REQ-004 | AC-003、AC-005 Git 后调用且禁用零请求 | Worker 单测 | TC-004 | 待执行 |
| REQ-005 | AC-004 上传失败与重投幂等 | ima adapter 合成测试 | TC-005 | 待执行 |

## 验收用例

- TC-001（P0）：匿名请求 Console，预期 Access 登录页同时提供 Google 与邮箱验证码。
- TC-002（P0）：登录后分别验证无 Key、有效 Key、无效 Key，预期双层边界不变。
- TC-003（P1）：仅键盘、移动宽度与 200% 缩放检查，预期无溢出且焦点/alert 可感知。
- TC-004（P0）：模拟 Git 成功/失败和 ima disabled，预期调用顺序与零请求契约成立。
- TC-005（P0）：模拟 COS/add_knowledge 失败和完成标记重投，预期不重复 Git/ima 副作用。

## 失败注入与恢复

- `AT-IMA-001`：知识库名称不存在或不唯一，预期 fail closed 且不上传 COS。
- `AT-IMA-002`：COS PUT 返回非 2xx，预期不调用 add_knowledge，任务可重试。
- `AT-IMA-003`：add_knowledge 超时，预期无完成标记，重投复用 Git 文件。
- `AT-IMA-004`：完成标记已存在，预期跳过所有 ima 网络请求。
- `AT-AUTH-001`：无 Access 会话，预期拿不到 Console HTML。
- `AT-AUTH-002`：Access 成功但 API Key 无效，预期回到解锁页并显示 alert。

## 发布门禁

- OpenSpec、需求设计、技术设计与验收设计校验必须通过。
- Console 与 Worker 聚焦测试、全工作区 test/typecheck/build 必须通过。
- `detect_changes` 不得出现范围外 symbol 或 HIGH/CRITICAL 风险。
- Secret 不得出现在 Git diff、测试输出、Cloudflare 配置响应或结构化日志中。
- 未完成 Key 轮换、Cloudflare 登录实测或 ima 合成导入时，不得宣称线上流程完成。

## 执行记录

当前尚未执行；命令、时间、结果和证据将在对应 OpenSpec task 完成时追加。

## 未执行项与阻塞项

- ima Key 轮换：浏览器会话当前不可用；生产验证前必须解除。
- Cloudflare/Sealos 线上变更：部署属于独立授权边界，未执行。

## 残余风险

- Cloudflare 托管登录页的具体布局受平台能力限制，需以登录设计配置和人工视觉检查收口。
- ima 对 add_knowledge 超时后的服务端状态不提供事务查询时，首次不确定结果可能需要人工确认同名条目。

## 验收结论

阻塞：当前只有设计证据，没有实现和线上执行证据。

## 覆盖统计

- 需求：5；已映射：5；已通过：0。
- 用例：5；已执行：0；阻塞：2 类线上门禁。
