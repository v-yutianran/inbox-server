# Cloudflare Access 与 ima 镜像验收方案

## 文档信息

- 验收对象：`add-cloudflare-access-ima-mirror`
- 版本：1.0
- 环境：本地合成环境、Cloudflare、Sealos `ns-tbs948af`
- 日期：2026-08-12
- 状态：部分通过，ima 线上验收阻塞
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

- 准入：OpenSpec 与三份 gate 文档有效，聚焦测试已建立，管理 API Key 已轮换；ima Key 仍须轮换。
- 退出：自动门禁全绿，线上匿名/登录/合成导入证据齐全，秘密扫描无命中。

## 追踪矩阵

| 需求 | 验收标准 | 自动证据 | 线上证据 | 状态 |
|---|---|---|---|---|
| REQ-001 | AC-001 匿名重定向且两种 IdP 可见 | Access 配置与登录页入口检查 | TC-001：302、最终页 200 | 通过 |
| REQ-002 | AC-002 有效/无效/缺失 Key 行为不回归 | Console 契约测试 10/10 | TC-002：200/401/401 | 通过 |
| REQ-003 | AC-002 语义、焦点、alert、响应式可用 | Console test/typecheck/build | TC-003 | 有条件通过 |
| REQ-004 | AC-003、AC-005 Git 后调用且禁用零请求 | Worker 单测 | TC-004 | 自动测试通过，线上未启用 |
| REQ-005 | AC-004 上传失败与重投幂等 | ima adapter 合成测试 | TC-005 | 自动测试通过，线上阻塞 |

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

- TC-001：匿名请求 Console 返回 302；重定向后的 Access 登录页返回 200，页面包含 Google 与邮箱入口。结果：通过。
- TC-002：用 Keychain 中轮换后的管理 Key请求受保护 API 返回 200；无 Key 与错误 Key 均返回 401；公开 `healthz` 返回 200。结果：通过。
- TC-003：Console API Key 契约测试 10/10，既有 test/typecheck/build 通过；浏览器工具不可用，未自动执行真实身份登录、纯键盘、200% 缩放和移动视口检查。结果：有条件通过。
- TC-004/TC-005：Worker 聚焦测试 29/29、全量门禁通过；生产 `IMA_MIRROR_ENABLED=false`，未调用 ima。结果：自动测试通过，线上未执行。
- Cloudflare Secret Change version `b3f6f991-316d-490f-9fac-e4579b7f0131` 已承载 100% 流量；秘密值未进入证据或仓库。

## 未执行项与阻塞项

- ima Key 轮换与 Sealos Secret 写入：缺少安全可用的轮换后凭据；不得复用聊天中已暴露的旧 Key。生产开关保持关闭。
- Access 真实身份浏览器 E2E：浏览器工具不可用，未输入真实账号或邮箱验证码；需人工复验纯键盘、移动宽度与 200% 缩放。

## 残余风险

- Cloudflare 托管登录页的具体布局受平台能力限制，需以登录设计配置和人工视觉检查收口。
- ima 对 add_knowledge 超时后的服务端状态不提供事务查询时，首次不确定结果可能需要人工确认同名条目。

## 验收结论

有条件通过：Cloudflare Access 与管理 API Key 双层授权已通过自动化契约和线上状态码验收；真实身份浏览器交互保留人工复验。ima 仅有实现与合成测试证据，因轮换后凭据缺失而阻塞，完整 change 不得宣称线上完成。

## 覆盖统计

- 需求：5；已映射：5；通过：2；有条件通过：1；线上阻塞：2。
- 用例：5；已执行自动/线上证据：5；未执行真实身份浏览器交互：1；未执行 ima 线上导入：2。
