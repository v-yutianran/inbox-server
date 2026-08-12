## Why

Console 目前仅依赖共享管理 API Key，缺少面向人的身份登录与清晰、克制的登录体验；文章 Markdown 也只完成 Git 权威归档，无法自动进入用户日常检索的 ima 知识库。现在需要在不削弱管理 API 鉴权、不改变 `raw/article` 权威事实源的前提下补齐这两条链路。

## What Changes

- 为 Console Pages 增加 Cloudflare Access 前置身份认证，同时支持 Google 与邮箱一次性验证码。
- 将 Cloudflare Access 登录品牌调整为接近滴答的简洁、居中、单主操作视觉，并优化 Console 内部 API Key 解锁页的层级、焦点、错误与响应式状态。
- 在 Git 文章归档成功后，把同一份 Markdown 作为独立镜像导入指定 ima 知识库。
- ima 镜像使用独立凭据、重名预检、限时请求、结构化低基数日志与失败重试；ima 失败不撤销已成功的 Git 权威归档。
- 不移除现有 `X-API-Key` 管理授权，不把 ima 凭据写入仓库、日志或 Cloudflare 前端。

## Capabilities

### New Capabilities

- `console-access-authentication`：定义 Cloudflare Access 的 Google/邮箱登录、品牌体验与双层授权边界。

### Modified Capabilities

- `article-markdown-archive`：在 Git 权威归档成功后增加可选、独立失败的 ima Markdown 镜像交付。

## Impact

- Console：`apps/console/src/App.tsx`、`apps/console/src/styles.css` 及聚焦测试。
- Worker：文章归档 application shell、新增 ima OpenAPI 适配器、配置与测试。
- 运行环境：Cloudflare Access application/organization login design；Sealos Worker Secret 与 Deployment 环境变量。
- 外部依赖：仅调用 `https://ima.qq.com/openapi/wiki/v1/*` 与其返回的腾讯 COS 临时上传地址，不新增 npm 运行时依赖。
- 安全：Access 只负责人的身份认证，`X-API-Key` 继续负责管理 API 授权；日志不包含邮箱、文章内容、完整 URL、凭据或 COS 临时密钥。
