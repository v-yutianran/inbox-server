## 1. git-manager 能力

- [x] 1.1 为可选自动 Release/CD 触发与确定性发布行为添加失败测试
- [x] 1.2 实现 git-manager 配置、workflow 模板和使用说明并通过测试

## 2. inbox-server 部署文件

- [x] 2.1 写入 `git-manager.yml` 并用 git-manager 生成受管 CI/CD workflow
- [x] 2.2 新增参数化 `entrypoint.sh`，校验共享配置并固定 Compose 项目名
- [x] 2.3 为部署入口添加静态与行为测试并更新 CHANGELOG

## 3. GitHub 与服务器配置

- [x] 3.1 创建 `testing` Environment 并配置部署变量、known_hosts 和专用 SSH 私钥
- [x] 3.2 在测试服务器创建发布结构、复用运行配置并授权专用部署公钥

## 4. 验证与交付

- [x] 4.1 运行 OpenSpec、ruff、非 E2E pytest、mypy、workflow 和 shell 校验
- [x] 4.2 运行 GitNexus detect changes，使用 git-manager 提交并推送 `main`
- [x] 4.3 等待 CI/CD，验证 Release、远端容器、端口、重启策略和持久化卷
