## 1. 行为测试

- [x] 1.1 添加 link 禁用固定窗口且保留每日限额的失败测试
- [x] 1.2 添加非 link 队列仍使用固定窗口的回归测试
- [x] 1.3 添加 runner 中 link 每日 500 条配置测试

## 2. 最小实现

- [x] 2.1 让消费器在 `window_count=0` 时跳过固定窗口令牌检查
- [x] 2.2 将 link 配置调整为无固定窗口、每日 500 条
- [x] 2.3 为 server、worker 显式设置 `TZ=Asia/Shanghai`
- [x] 2.4 更新 CHANGELOG 说明行为与验证方式

## 3. 验证与部署

- [x] 3.1 运行针对性测试、ruff、非 E2E 测试和 mypy
- [x] 3.2 运行 OpenSpec 校验和 GitNexus 变更影响检查
- [x] 3.3 停止 worker，以只读预检确认旧/新日计数后一次性合并两段计数
- [x] 3.4 强制重建 server、worker并验证时区、健康状态、重启策略和计数连续性
