## MODIFIED Requirements

### Requirement: Git 仓库归档与原始 URL 幂等交付
系统 SHALL 将 Markdown 保存到宿主机 `~/.agents/references/article`，并 MUST 在每次成功创建或补交文章后提交当前文章文件并推送 `.agents` 仓库远端。

#### Scenario: 归档新文章并推送
- **WHEN** Markdown 已通过正文验收，且仓库中不存在 frontmatter `source_url` 与原始 URL 精确相同的文章
- **THEN** 系统 SHALL 原子写入 `references/article/<安全文件名>`、仅提交该文章路径并立即 push

#### Scenario: 原始 URL 已存在
- **WHEN** 仓库中已有文章的 frontmatter `source_url` 与原始 URL 精确相同
- **THEN** 系统 SHALL 不重复创建文章，并 MUST 确保已有文章对应的本地提交已推送后把任务作为成功完成

#### Scenario: 同名文章来自不同 URL
- **WHEN** 安全文件名已存在但其 `source_url` 与当前原始 URL 不同
- **THEN** 系统 SHALL 在文件名中追加原始 URL 的稳定短指纹并创建新文件，且 MUST NOT 覆盖已有文章

#### Scenario: 保留无关工作区改动
- **WHEN** `.agents` 仓库存在与当前文章无关的暂存、未暂存或未跟踪内容
- **THEN** 系统 MUST 仅把当前文章路径加入本次提交，且 MUST NOT 修改或提交其它内容

#### Scenario: Git 同步、提交或推送临时失败
- **WHEN** `pull --ff-only`、commit 或 push 失败
- **THEN** 系统 SHALL 将归档任务判定为失败并按现有重试策略处理，且 MUST NOT 强制推送或覆盖远端历史

#### Scenario: 重试补交中间状态
- **WHEN** 上一次尝试已写入文件但未提交，或已提交但未推送
- **THEN** 系统 SHALL 复用现有文章文件完成缺失的 commit 或 push，且 MUST NOT 生成重复文件

#### Scenario: 重试耗尽进入死信队列
- **WHEN** 归档任务达到现有最大重试次数仍未成功
- **THEN** 系统 SHALL 将该任务移入独立文章归档 DLQ，并保留 URL、标题、重试次数和失败上下文供运维排查

## REMOVED Requirements

### Requirement: 坚果云归档与幂等跳过

**Reason**: 用户已将 `.agents/references/article` Git 仓库指定为文章 Markdown 的唯一自动归档目标，不再需要坚果云双写。

**Migration**: 保留坚果云现有历史文件不动；新归档任务从部署本变更后仅写入并推送 `.agents` 仓库。
