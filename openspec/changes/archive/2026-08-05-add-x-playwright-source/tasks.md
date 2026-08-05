## 1. 解析与采集能力

- [x] 1.1 新增 X 推文数据模型、DOM 解析纯函数与单元测试，覆盖 tweet id、permalink、作者、正文摘要和无效条目跳过。
- [x] 1.2 新增 Playwright scraper，支持 Bookmarks 与 Likes 页面滚动采集，并在登录态失效或页面异常时返回可诊断错误。
- [x] 1.3 新增 `x_bookmarks` 与 `x_likes` source，按 tweet id 使用持久化基准去重，入队 link payload。
- [x] 1.4 支持同一轮收藏与喜欢重叠时合并 `x-bookmarks`、`x-likes` 标签并只入队一次。

## 2. 注册、配置与凭据

- [x] 2.1 注册 X source 与登录策略，复用 session 类 `x_creds` storage_state 凭据。
- [x] 2.2 扩展 channels 配置校验与 `.env.example`/示例配置说明，使 `x_bookmarks` 与 `x_likes` 可配置启用。
- [x] 2.3 新增 X baseline 初始化脚本或等价说明，支持首次启用前预填 tweet id 基准。

## 3. 验证与收尾

- [x] 3.1 补充 registry、channels config、source collect 单元测试。
- [x] 3.2 运行 OpenSpec 校验、相关单元测试、lint 和类型检查。
- [x] 3.3 更新 `CHANGELOG.md`，记录改动内容和验证方式。
