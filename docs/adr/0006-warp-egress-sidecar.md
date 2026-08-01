---
status: accepted
---

# 使用 WARP Sidecar 提供受控出站网络

Sealos 北京区域能直连 Cloudflare 控制面和部分内容站点，但 Telegram、YouTube、Inoreader 与 X 的直接访问不稳定或超时；把本机 ClashX 配置复制到云端会引入个人代理凭据、节点生命周期和不可审计的第三方依赖。决定在 worker Pod 内运行固定版本的官方 Cloudflare WARP 客户端，以非 root、无额外 Linux capability 的本地 SOCKS5 代理模式提供出站通道，并把 WARP 注册状态保存到独立 PVC。

WARP 在该区域的代理内置 DNS 不能可靠解析全部目标，因此 worker 增加仅监听 Pod loopback 的 HTTP CONNECT 适配器：通过 WARP 查询 Cloudflare DoH 获得目标 IP，再用该 IP 经 WARP 建连。Node HTTP 客户端和 headed Chromium 统一使用此适配器；代理未通过 `warp=on` 就绪检查时，worker 不进入 Ready，也不领取任务。

Git smart-HTTP 的 pack 传输是受控例外：同一 Pod 内经 CONNECT 适配器执行浅克隆和 `pull` 均在 180 秒超时，清空 Git 子进程的代理环境后浅克隆在 24 秒完成。因此文章仓库的 Git 子进程只通过 HTTPS 直连 GitHub，普通 Node HTTP 与 headed Chromium 仍必须经过 WARP；该例外不创建入站服务，也不把本机 ClashX 配置或代理凭据带入云端。

具体实现范围、回滚门槛和线上验证见 [`migrate-to-typescript-cloudflare`](../../openspec/changes/migrate-to-typescript-cloudflare/design.md)。
