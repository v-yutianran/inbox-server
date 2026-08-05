## 1. Git 归档端口与适配器

- [x] 1.1 为文章归档服务添加 `save_if_absent` 公共端口测试并确认旧 WebDAV 实现测试先失败
- [x] 1.2 实现本地 Git 适配器的 URL 精确去重、同名冲突、路径级提交和 push
- [x] 1.3 覆盖已写未提交、已提交未推送、无关工作区改动和 Git 失败测试

## 2. Worker 与部署接入

- [x] 2.1 修改归档配置和 worker 构建逻辑，移除文章归档对坚果云凭据的依赖
- [x] 2.2 修改 Compose 挂载 `.agents` 仓库并通过 HTTPS askpass 鉴权，验证容器 Git push 能力
- [x] 2.3 更新当前配置、示例配置和 CHANGELOG

## 3. 验证与交付

- [x] 3.1 运行文章归档定向测试和项目自验四件套
- [x] 3.2 重建 worker，实际投递未归档文章 URL 并验证 frontmatter、正文清理、本地提交和远端文件树
- [x] 3.3 运行 OpenSpec、文档审计和 GitNexus 变更检查后提交并推送 inbox-server
