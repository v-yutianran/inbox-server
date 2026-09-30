# Design

## Context

见 proposal.md。Playwright `connectOverCDP` 返回的 browser 调用 `close()` 只释放连接；必须显式发送浏览器级关闭命令。现有 application shell 的批次拥有连接，业务队列仍由既有领域模型拥有。只调整资源生命周期，不引入新 Aggregate 或领域事件。

## Goals / Non-Goals

**Goals:** 真实关闭会话、60 秒异常断线兜底、保留成功与失败结算语义。

**Non-Goals:** 重构来源、修改历史任务、引入遥测 SDK。

## Decisions

- 在既有 finally 中建立 browser CDP session 并发送 `Browser.close`；嵌套 finally 保证客户端关闭。避免新增 HTTP 关闭接口及 session ID 管理。
- 将现有连接参数改为 `keep_alive=60000`。60 秒只限制空闲，不限制持续活动的批次。
- 单测覆盖成功、业务失败和清理失败；真实 E2E 使用隔离的合成页面。Cloudflare 控制台核对 NormalClosure 与 BrowserIdle。
- 本次边界沿用现有结构化入口日志；未安装 OpenTelemetry SDK，不新增重复信号，不宣称完整 OTel 合规。

## Risks / Trade-offs

- 关闭命令可能随连接终止而拒绝 → 先真实验证响应，再决定是否需识别正常断线；其他错误不能默默吞掉。
- 60 秒空闲可能影响长时间没有 CDP 活动的采集 → 活跃采集保持原流程；观察正常生产批次。
- 工作区存在其他已暂存迁移 → 生产基于现有镜像仅覆盖 browser.js，不整体发布工作区。

## Migration Plan

本地 RED/GREEN/回归通过后，运行真实远程 E2E。保存当前 revision，构建单模块补丁镜像，以零流量 revision 检查启动，切换流量并核对生产 webhook；同一部署镜像内再次执行远程生命周期 E2E。资源清理边界通过隔离页面验证，不额外触发来源采集或分发；下一整点自然批次作为后续观察。必要时恢复原 revision。Git 精确隔离本次路径后提交推送。
