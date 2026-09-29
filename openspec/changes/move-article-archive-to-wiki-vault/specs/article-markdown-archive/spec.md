# Spec Delta

## MODIFIED Requirements

### Requirement: Obsidian 安全 Markdown
系统 SHALL 生成带稳定且可被 YAML 解析器读取的 Obsidian Properties 的 Markdown，文件名 MUST 使用 Asia/Shanghai 归档日期、移除全部空白和特殊字符，且含扩展名与碰撞指纹后 MUST 不超过 180 个 UTF-8 字节。

#### Scenario: 生成文件名
- **WHEN** 标题为可归档文章标题且归档日期为某一自然日
- **THEN** 文件名 SHALL 为 `YYYYMMDD-文章标题.md`，且 MUST 不包含空格、其它空白或 Obsidian 不安全特殊字符

#### Scenario: 超长中文标题
- **WHEN** 安全标题使文件名超过 180 个 UTF-8 字节
- **THEN** 系统 SHALL 在完整 Unicode 字符边界截断标题，且最终文件名 MUST 不超过 180 个 UTF-8 字节

#### Scenario: 标题清洗后为空
- **WHEN** 标题经 Unicode 规范化和安全字符清洗后为空
- **THEN** 系统 SHALL 使用原文主机名和 URL 稳定短指纹生成非空且确定性的文件名

#### Scenario: 写入 Obsidian Properties
- **WHEN** 系统生成文章 Markdown
- **THEN** frontmatter SHALL 包含 `title`、`source_url`、`archived_at`、`author`、`published_at`、`tags`，其中标签 MUST 沿用提交给 Cubox 的智能标签

#### Scenario: Properties 保持合法 YAML
- **WHEN** 标题、原文链接或标签包含引号、查询参数或空值
- **THEN** 六个 Properties SHALL 各自独立成行、正确转义并由独立结束分隔符封闭，且 MUST 能被 YAML 解析器还原为原始值

#### Scenario: 保留远程图片
- **WHEN** Defuddle 正文包含图片
- **THEN** 系统 SHALL 保留远程图片 URL，且 MUST NOT 下载图片、改写为本地资源或内嵌二进制内容

### Requirement: Git 仓库归档与原始 URL 幂等交付
系统 SHALL 将 Markdown 保存到宿主机 `~/.agents/.wiki-vault/raw/article`，并 MUST 在每次成功创建或补交文章后提交当前文章文件并推送 `.agents` 仓库远端。

#### Scenario: 归档新文章并推送
- **WHEN** Markdown 已通过正文验收，且仓库中不存在 frontmatter `source_url` 与原始 URL 精确相同的文章
- **THEN** 系统 SHALL 原子写入 `.wiki-vault/raw/article/<安全文件名>`、仅提交该文章路径并立即 push

#### Scenario: 原始 URL 已存在
- **WHEN** 仓库中已有文章的 frontmatter `source_url` 与原始 URL 精确相同
- **THEN** 系统 SHALL 不重复创建文章，并 MUST 确保已有文章对应的本地提交已推送后把任务作为成功完成

#### Scenario: 同名文章来自不同 URL
- **WHEN** 安全文件名已存在但其 `source_url` 与当前原始 URL 不同
- **THEN** 系统 SHALL 在文件名中追加原始 URL 的稳定短指纹并创建新文件，最终文件名 MUST 不超过 180 个 UTF-8 字节，且 MUST NOT 覆盖已有文章

#### Scenario: 保留无关工作区改动
- **WHEN** `.agents` 仓库存在与当前文章无关的暂存、未暂存或未跟踪内容
- **THEN** 系统 MUST 仅把当前文章路径加入本次提交，且 MUST NOT 修改或提交其它内容

#### Scenario: 本地文章提交与远端分支分叉
- **WHEN** 本地存在尚未推送的文章提交，且远端分支已包含其它新增提交
- **THEN** 系统 SHALL 将本地文章提交安全 rebase 到远端分支后推送，并 MUST NOT 强制推送或覆盖远端历史

#### Scenario: Git 同步冲突或提交失败
- **WHEN** rebase 发生冲突，或 commit 最终失败
- **THEN** 系统 SHALL 中止未完成的 rebase、保留本地文章提交并将归档任务判定为失败，且 MUST NOT 强制推送或覆盖远端历史

#### Scenario: 推送期间远端再次前进
- **WHEN** push 因远端在同步后再次新增提交而失败
- **THEN** 系统 SHALL 在有界次数内重新 rebase 并重试 push，重试耗尽后按现有失败策略处理

#### Scenario: 重试补交中间状态
- **WHEN** 上一次尝试已写入文件但未提交，或已提交但未推送
- **THEN** 系统 SHALL 复用现有文章文件完成缺失的 commit 或 push，且 MUST NOT 生成重复文件

#### Scenario: 重试耗尽进入死信队列
- **WHEN** 归档任务达到现有最大重试次数仍未成功
- **THEN** 系统 SHALL 将该任务移入独立文章归档 DLQ，并保留 URL、标题、重试次数和失败上下文供运维排查
