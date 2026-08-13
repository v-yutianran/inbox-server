## MODIFIED Requirements

### Requirement: Git 仓库归档与原始 URL 幂等交付
系统 SHALL 将 Markdown 保存到宿主机 `~/.agents/raw/article`，并 MUST 在每次成功创建或补交文章后提交当前文章文件并推送 `.agents` 仓库远端；启用 ima 镜像时，系统 SHALL 在 Git 权威归档成功后把同一份 Markdown 独立导入所配置的 ima 知识库。

#### Scenario: 归档新文章并推送
- **WHEN** 一条新文章归档任务完成提取与 Markdown 渲染，且原始 URL 未在 `raw/article` 归档中出现
- **THEN** 系统 SHALL 在 `raw/article` 创建 Markdown，提交且推送该文件，并在启用 ima 镜像时尝试导入同一份内容

#### Scenario: 原始 URL 已存在
- **WHEN** `raw/article` 已有任一 Markdown 的 frontmatter `source` 等于当前规范化原始 URL
- **THEN** 系统 SHALL 确保已有文章对应的本地提交已推送后把 Git 归档作为成功完成，且 MUST NOT 创建第二个 Git 文件

#### Scenario: 同名文章来自不同 URL
- **WHEN** 文件名已存在但原始 URL 不同
- **THEN** 系统 SHALL 为原文件名追加 URL 的稳定短指纹并创建新文件

#### Scenario: 保留无关工作区改动
- **WHEN** `.agents` 仓库存在与当前文章无关的暂存、未暂存或未跟踪文件
- **THEN** 系统 MUST 仅把当前文章路径加入本次提交，并 MUST NOT stash、覆盖或提交其它路径

#### Scenario: 本地文章提交与远端分支分叉
- **WHEN** 本地存在尚未推送的文章提交，且远端分支已包含其它新增提交
- **THEN** 系统 SHALL 将本地文章提交安全 rebase 到远端分支后推送，并 MUST NOT 强制推送或覆盖远端历史

#### Scenario: Git 同步冲突或提交失败
- **WHEN** rebase 发生冲突，或 commit 最终失败
- **THEN** 系统 SHALL 中止未完成的 rebase、保留本地文章提交并将归档任务判定为失败，且 MUST NOT 强制推送或覆盖远端历史

#### Scenario: 推送期间远端再次前进
- **WHEN** push 因远端在同步后再次新增提交而失败
- **THEN** 系统 SHALL 在有界次数内重新 rebase 并重试 push，重试耗尽后按现有失败策略处理

#### Scenario: Git 同步、提交或推送临时失败
- **WHEN** `pull --ff-only`、commit 或 push 失败
- **THEN** 系统 SHALL 将归档任务判定为失败并按现有重试策略处理，MUST NOT 调用 ima 镜像，且 MUST NOT 强制推送或覆盖远端历史

#### Scenario: ima 镜像成功
- **WHEN** Git 权威归档已成功且 ima 凭据、目标知识库和上传流程均有效
- **THEN** 系统 SHALL 完成重名预检、文件上传与知识导入，并 SHALL 记录不含内容、完整 URL 或凭据的成功事件

#### Scenario: ima 副本适配元数据
- **WHEN** 本地 Git 归档 Markdown 包含 YAML frontmatter 且系统准备镜像到 ima
- **THEN** 系统 SHALL 保持本地 Git 文件不变，仅在 ima 副本中移除 frontmatter、保留标题与正文，并在正文底部追加来源链接，且 MUST NOT 生成“文章信息”区块

#### Scenario: ima 副本按月份归档
- **WHEN** 本地 Git 归档文件名为 `YYYYMMDD-<名称>.md` 且系统准备镜像到 ima
- **THEN** 系统 SHALL 按 `get_knowledge_list` 返回的 `title` 精确定位 ima 根目录下唯一的 `YYYYMM` 文件夹，使用 `<名称>.md` 作为文件名，并将该条目的 `media_id` 作为后续请求的 `folder_id` 归入该月份文件夹

#### Scenario: ima 月份文件夹不可用
- **WHEN** ima 根目录下不存在目标 `YYYYMM` 文件夹或存在多个同名文件夹
- **THEN** 系统 SHALL 使本次镜像失败并复用现有重试与 DLQ 边界，且 MUST NOT 退回根目录或把月份编码进文件名

#### Scenario: ima 镜像失败
- **WHEN** Git 权威归档已成功但 ima 网络、凭据、配额、重名策略或导入步骤失败
- **THEN** 系统 SHALL 保留 Git 成功结果，将本次任务判定为可重试失败并复用现有文章任务重试与 DLQ 边界，且 MUST NOT 重复创建 Git 文章

#### Scenario: ima 镜像未配置
- **WHEN** 未启用 ima 镜像或缺少完整的非秘密配置
- **THEN** 系统 SHALL 仅执行现有 Git 权威归档，不得向 ima 或 COS 发起请求

#### Scenario: 重试补交中间状态
- **WHEN** 上一次尝试已写入文件但未提交、已提交但未推送，或已完成 Git 但 ima 镜像失败
- **THEN** 系统 SHALL 复用现有文章文件完成缺失的 Git 步骤，并仅重试未完成的 ima 镜像步骤

#### Scenario: 重试耗尽进入死信队列
- **WHEN** 归档或启用的 ima 镜像达到现有最大重试次数仍未成功
- **THEN** 系统 SHALL 将该任务移入独立文章归档 DLQ，并保留 URL 摘要、标题摘要、重试次数和低敏失败上下文供运维排查
