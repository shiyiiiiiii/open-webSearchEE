# C03 浏览器部署与验收

日期：2026-10-11。代码已提供 context 防护、固定 IP 建连的代理、独立浏览器部署和验收工具。实际网络策略必须在浏览器所在机器实施；环境变量是部署声明，不会创建防火墙规则，也不是验证证据。

浏览器入口现在要求：

| 配置 | 要求 |
| --- | --- |
| `BROWSER_EGRESS_PROXY_URL` | 浏览器所在网络可达的受控 HTTP 代理 origin，不包含凭据、路径、查询参数；不能用普通转发代理代替目的地址校验 |
| `BROWSER_EGRESS_ENFORCED=true` | 运维已部署并验收禁止直连的网络策略后设置。本地、WS、CDP 模式均适用 |
| `BROWSER_ALLOWED_PORTS` | 默认 `80,443`；所有条目为 1—65535 的 TCP 端口。应用、代理和网络规则必须一致 |

未配置出口声明时，浏览器任务返回 `browser_egress_unverified`，HTTP 请求模式仍可使用。代理配置无效、防护 API 不支持或注册失败时不会降级。普通 worker、Service Worker、WebSocket、WebTransport 和 WebRTC 默认不开放；主页面 JavaScript 和合法 iframe 保留。新增文档 CSP 会限制依赖这些功能的站点。

浏览器进程可以共享，每个任务的 context、页面和状态独立；Cookie 采集也遵循此规则。Bing 不再使用默认 profile 维持反机器人状态。需要持久化状态的兼容方案必须另行验证，不能恢复原先的不受控回退。

## 独立容器部署

从仓库根目录在支持 Linux 容器及 iptables/ip6tables 的 Docker 主机执行：

```sh
docker compose -f deploy/browser/docker-compose.yml up -d --build
docker compose -f deploy/browser/docker-compose.yml ps
```

该配置使用固定的 `172.30.0.0/24` 内部网络。若与现有网络冲突，应同时修改 Compose IP、出口 URL、worker 防火墙和验收工具中的地址。

- 浏览器容器仅接入内部网络，出站只允许 `172.30.0.2:3128/TCP`。没有 loopback、IPv6、UDP、DNS 或管理端口的主动连接例外。已有控制连接的响应通过 conntrack 放行。
- 代理独立接入外网，自行向固定 DNS `1.1.1.1:53` 解析 A/AAAA；全部答案通过地址检查后，直接使用具体 IP 建连。`FAKE_IP_CIDRS` 不适用于代理。
- 代理容器也拒绝项目必禁网段及其他非公网范围；IPv6 仅允许经过规则过滤的全球单播范围。应用代码继续逐地址校验。
- 防火墙安装失败时入口脚本退出，不启动 worker。安装规则后降为 uid 1200，浏览器和代理运行进程不持有 NET_ADMIN。
- 浏览器控制端口及代理端口不映射到宿主机；app HTTP 端口默认绑定宿主机 `127.0.0.1:3000`。
- HTTPS CONNECT 保留浏览器 TLS SNI 和证书验证；没有 MITM、DIRECT、PAC 或上游代理回退。

代理输出 `browser_egress_decision` JSON 日志，记录允许/拒绝、目标主机、端口、已解析的数值 IP 和选中的连接地址；不包含 URL 路径、查询参数、凭据或原始错误。每条日志最多记录 16 个地址，并保留地址总数；校验仍检查全部答案。

规则只在专用容器网络命名空间中执行。不要把 `entrypoint.sh` 当成宿主机防火墙安装脚本。若需要企业 DNS，应一起修改代理解析器和对应的精确 DNS 出口规则，不能只更改系统 resolver。

## 网络层独立验收

测试叠加配置只部署无敏感数据的 canary；不要把测试端口配置用于生产。容器重新创建可清零计数。以下命令先验证浏览器 namespace 的原始 TCP/UDP，再验证没有应用守卫的真实浏览器及代理：

```sh
docker compose -f deploy/browser/docker-compose.yml -f deploy/browser/docker-compose.test.yml up -d --build --force-recreate
docker compose -f deploy/browser/docker-compose.yml -f deploy/browser/docker-compose.test.yml exec -T --user worker browser node build/tools/verifyBrowserEgress.js --from-worker
docker compose -f deploy/browser/docker-compose.yml -f deploy/browser/docker-compose.test.yml exec -T app node build/tools/verifyBrowserEgress.js
docker compose -f deploy/browser/docker-compose.yml -f deploy/browser/docker-compose.test.yml exec -T browser iptables -S OUTPUT
docker compose -f deploy/browser/docker-compose.yml -f deploy/browser/docker-compose.test.yml exec -T browser ip6tables -S OUTPUT
docker compose -f deploy/browser/docker-compose.yml -f deploy/browser/docker-compose.test.yml logs --no-color proxy
```

验收结果必须包含 canary 的 `tcp=0,http=0,udp=0`、禁止直连和故障代理不回退，以及防火墙规则。IPv6 规则需在目标主机检查；若要证明特定 IPv6 服务不可达，还需部署对应的可达 IPv6 canary，不能把服务未监听当成阻断证据。公网正常 HTTPS、实际 Bing 和业务站点兼容性需在部署环境验证并记录浏览器及 Playwright 版本。

## 应用与代理代码验收

在已安装依赖的开发环境运行：

```sh
npm run build
node build/test/test-browser-network-policy.js
node build/test/test-page-pool-lock.js
node build/test/test-browser-egress-proxy.js
node build/test/test-browser-redirect-safety.js
```

最后一个测试需要 Chromium/Chrome/Edge。它使用临时浏览器与自建代理、私网 canary，覆盖逐跳跳转、弹窗、WebSocket、OOPIF、worker、生产 HTML/Cookie/MCP 工具/HTTP daemon 入口和恶意求值超时。代理测试用受控传输把已验证的公网数值 IP 映射到自建服务，验证 DNS 变化和混合地址不会建立禁止连接；不访问第三方目标。缺少浏览器时测试会明确 SKIP，不能据此认定通过。

## 生命周期与运维

任务整体期限默认 15 秒，覆盖预检、连接、初始化和操作；清理最多再等待 3 秒。超时会主动关闭整个 context，停止后台页面和 worker。跨进程容量锁同一 profile 命名空间最多允许四个任务，释放不会复用旧 context。

必要 CDP 连接脱离、子 target 安装失败或浏览器断线均使任务失效。新连接重新初始化全部防护。清理失败会隔离浏览器连接及相应 endpoint；需先回收故障专用 worker，再重启服务解除隔离。不会因抓取失败终止他人共享浏览器。

Windows 本地浏览器和其他远程供应方也必须提供等效出口隔离。仅设置上述环境变量、Chromium 代理参数或 Node DNS 预检不能替代网络限制。当前开发环境没有 Docker/可用 WSL，因此此容器部署和目标主机网络验收尚未执行；C03 综合关闭仍需这些部署证据，C04 的 Node HTTP 代理分支仍单独跟踪。
