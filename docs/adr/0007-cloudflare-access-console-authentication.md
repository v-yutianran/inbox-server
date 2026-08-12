---
status: accepted
---

# 使用 Cloudflare Access 保护运维 Console

运维 Console 需要人的身份认证，但现有管理 API 已以 `X-API-Key` 表达操作授权。决定在 Console Pages host 前增加 Cloudflare Access，由 Google 与 One-time PIN 提供身份登录；登录后仍必须在浏览器会话中输入管理 API Key 才能调用管理端点。

Access 与 API Key 分别回答“谁可以进入 Console”和“谁可以执行管理操作”。因此不把 Access token 改造成管理凭据，也不在 React 中重复实现 Google 或邮箱验证码按钮。Access application 只保护 Console host，API 健康与 Worker 内部端点继续使用各自既有边界。

具体需求、部署门槛与验收场景见 [`add-cloudflare-access-ima-mirror`](../../openspec/changes/add-cloudflare-access-ima-mirror/design.md)。
