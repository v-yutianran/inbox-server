## 1. Source 实现

- [x] 1.1 新增 GitHub Star 解析与分页收集逻辑
- [x] 1.2 使用 `IncrementalBaselineRepo` 保存 `github_stars` 已知仓库 URL

## 2. 编排与配置

- [x] 2.1 在渠道配置校验中注册 `github_stars` 的 Token 配置
- [x] 2.2 在 API source 编排中启用 `github_stars`
- [x] 2.3 在示例配置中补充 `github_stars` source

## 3. 测试与验证

- [x] 3.1 补充 GitHub Star source 单元测试
- [x] 3.2 补充 channels 配置校验测试
- [x] 3.3 运行 OpenSpec 校验与相关自动化测试
