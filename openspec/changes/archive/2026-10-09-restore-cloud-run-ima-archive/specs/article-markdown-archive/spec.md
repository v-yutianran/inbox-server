## ADDED Requirements

### Requirement: Cloud Run 的 ima 镜像归档
已启用 ima 的云端 Worker SHALL 使用有效认证向唯一目标知识库归档 Markdown，保持 Git 原文归档行为及内容不变。系统 MUST 仅在 ima 导入确认且完成状态持久化后报告镜像成功。

#### Scenario: 云端正常归档
- **WHEN** Cloud Run 处理一篇新的可归档文章且依赖可用
- **THEN** 正确月份目录含该文章，Git 原文仍保留，并记录镜像成功事件

#### Scenario: 导入后的状态写失败
- **WHEN** ima 导入已经完成但完成状态保存失败
- **THEN** 系统不报告镜像成功且不自动重放未知副作用

### Requirement: 跨云端实例保留镜像完成记录
Cloud Run SHALL 在实例替换后仍识别已完成的 ima 镜像并跳过重复上传；本机持久文件标记 SHALL 保持兼容。

#### Scenario: 冷启动重投
- **WHEN** 已确认完成的同来源文章在另一云端实例重投
- **THEN** 不再次请求 ima 或 COS

#### Scenario: 本机旧标记
- **WHEN** 本机独立 Worker 的持久目录存在该来源完成标记
- **THEN** 仍跳过 ima 镜像

### Requirement: 自动准备 ima 月份目录
系统 SHALL 将文章放入 YYYYMM 文件夹，缺失时自动创建并确认唯一匹配；重复目录、创建失败或未确认的同名文章 MUST 阻止上传。

#### Scenario: 月份文件夹缺失
- **WHEN** 目标知识库根目录完整分页后没有目标月份文件夹
- **THEN** 创建目标月份文件夹，确认唯一目录后归档

#### Scenario: 名称冲突
- **WHEN** 存在多个同名月份文件夹或无完成记录的同名文章
- **THEN** 拒绝导入，不覆盖、不改名、不写入根目录
