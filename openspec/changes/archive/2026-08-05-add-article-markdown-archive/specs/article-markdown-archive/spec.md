## ADDED Requirements

### Requirement: Cubox 成功后的归档任务独立交付
系统 SHALL 仅在链接成功保存到 Cubox 后创建独立文章归档任务，并 MUST 保持 Cubox 成功状态不受归档任务后续结果影响。

#### Scenario: Cubox 成功后创建归档任务
- **WHEN** link 队列项完成智能标签生成且 Cubox 返回成功
- **THEN** 系统 SHALL 创建包含原文链接、标题、智能标签和归档请求时间的独立归档任务

#### Scenario: Cubox 失败时不创建归档任务
- **WHEN** Cubox 返回失败、配额限制或抛出异常
- **THEN** 系统 MUST NOT 创建文章归档任务

#### Scenario: 归档失败不重试 Cubox
- **WHEN** 已创建的文章归档任务抓取、解析或上传失败
- **THEN** 系统 SHALL 仅重试归档任务，并 MUST NOT 再次向 Cubox 分发原链接

#### Scenario: 不回填历史链接
- **WHEN** 功能首次启用
- **THEN** 系统 SHALL 仅处理启用后由 Cubox 成功事件创建的归档任务

### Requirement: 文章型网页内容检测
系统 SHALL 通过 URL 预排除和 Defuddle 正文验收识别文章型网页，且 MUST 将确定的非文章结果作为正常跳过处理。

#### Scenario: 已知非文章链接预排除
- **WHEN** 链接不是 HTTP(S)，或属于已知视频页、代码仓库页、下载文件类型
- **THEN** 系统 SHALL 记录跳过原因并完成该归档任务，不调用 Playwright、不进入重试或 DLQ

#### Scenario: 有效文章通过正文验收
- **WHEN** Defuddle 返回有效标题，且移除元数据、链接和空白后的正文达到最小有效长度
- **THEN** 系统 SHALL 将该网页识别为文章并继续生成 Markdown

#### Scenario: 两次解析后仍不是文章
- **WHEN** 直接解析不足且 headed Playwright 兜底后的 Defuddle 结果仍不满足正文标准
- **THEN** 系统 SHALL 将该网页作为非文章正常跳过，不进入重试或 DLQ

### Requirement: Defuddle 生产集成与 Playwright 兜底
系统 MUST 在 inbox-server worker 镜像中集成受依赖锁管理的固定版本 Defuddle，并 SHALL 在直接抓取或首次解析不足时使用现有 headed Playwright 获取完整 HTML 后重新解析。

#### Scenario: 直接抓取成功
- **WHEN** 直接 HTTP 抓取获得 HTML，且 Defuddle 首次解析通过正文验收
- **THEN** 系统 SHALL 使用首次解析结果，且 MUST NOT 启动 Playwright 兜底

#### Scenario: 内容不足时启动 headed Playwright
- **WHEN** 直接抓取失败、命中错误页标记、缺少标题或正文不足
- **THEN** 系统 SHALL 使用 headed Playwright 获取渲染后 HTML，并 MUST 再次调用 Defuddle

#### Scenario: 运行时不依赖全局 skill
- **WHEN** worker 在容器中处理文章归档任务
- **THEN** 系统 MUST 使用仓库内锁定的 Defuddle 依赖和桥接器，且 MUST NOT 依赖宿主机全局 `weixin-article` skill 或全局 npm 包

#### Scenario: Defuddle 或 Playwright 临时故障
- **WHEN** Defuddle 子进程超时、异常退出，或 Playwright 导航发生可恢复错误
- **THEN** 系统 SHALL 将任务判定为失败并应用独立归档重试策略

### Requirement: Obsidian 安全 Markdown
系统 SHALL 生成带稳定且可被 YAML 解析器读取的 Obsidian Properties 的 Markdown，文件名 MUST 使用 Asia/Shanghai 归档日期并移除全部空白和特殊字符。

#### Scenario: 生成文件名
- **WHEN** 标题为可归档文章标题且归档日期为某一自然日
- **THEN** 文件名 SHALL 为 `YYYYMMDD-文章标题.md`，且 MUST 不包含空格、其它空白或 Obsidian 不安全特殊字符

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

### Requirement: 坚果云归档与幂等跳过
系统 SHALL 使用现有坚果云 WebDAV 凭据将 Markdown 上传到 `/我的坚果云/文章归档`，并 MUST 在目标文件存在时跳过覆盖。

#### Scenario: 上传新文章
- **WHEN** Markdown 已通过正文验收且远端目标文件不存在
- **THEN** 系统 SHALL 将非空 Markdown 上传到 `/我的坚果云/文章归档/<安全文件名>`

#### Scenario: 目标文件已存在
- **WHEN** WebDAV 检查发现完整目标路径已经存在
- **THEN** 系统 SHALL 将任务作为成功跳过，且 MUST NOT 覆盖、重命名或修改目标文件

#### Scenario: WebDAV 临时失败
- **WHEN** WebDAV 存在检查或上传发生超时、连接错误或服务端临时错误
- **THEN** 系统 SHALL 将归档任务判定为失败并按现有重试策略处理

#### Scenario: 重试耗尽进入死信队列
- **WHEN** 归档任务达到现有最大重试次数仍未成功
- **THEN** 系统 SHALL 将该任务移入独立文章归档 DLQ，并保留 URL、标题、重试次数和失败上下文供运维排查
