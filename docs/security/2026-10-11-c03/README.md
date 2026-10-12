# C03 实施与验证记录

日期：2026-10-11，Asia/Shanghai。依据：[C03 综合方案](../C03-browser-network-remediation.zh-CN.md)。

**应用防护、代理组件和部署配置已实现；目标部署验收与实际 Bing 兼容性仍待完成，C03 尚未整体关闭。** 当前 Windows 环境没有 Docker 或可用 WSL，不能在此确认 Linux 容器、防火墙与远程机器的实际出口。

## 按方案顺序落实

| 顺序 | 实施结果 | 状态 |
| --- | --- | --- |
| 1. 统一 context 入口 | 新增 `browserNetworkPolicy.ts`；任务专用 context，先注册 HTTP/WebSocket，再创建页面、安装 CDP 并标记 ready。迁移 HTML、Cookie、Cookie/HTTP 竞速和 Bing；移除默认 context 回退和旧页面复用 | 已实现、已验证 |
| 2. 通道及生命周期 | 拒绝未授权页面首请求；默认阻止 WebSocket、Service Worker、普通 worker、WebTransport/WebRTC；OOPIF 在恢复执行前安装逐跳检查。初始化失败、CDP 脱离、断线、取消和超时均关闭任务 context；清理失败隔离连接及 endpoint | 已实现、应用侧验证通过 |
| 3. 实际出口 | 代理自行解析全部 A/AAAA，拒绝禁止地址并按已验证的数值 IP 建连，HTTPS 保留原始 TLS。提供独立 browser/proxy 容器、IPv4/IPv6 出站规则及独立 canary 验收工具 | 组件测试通过；实际部署待验收 |
| 4. 更新结论 | 更新方案状态、配置说明、HTTP 文档和本记录，保留测试日志及源码哈希 | 记录已更新；未宣布整体关闭 |

探索范围包括 `src` 的入口、HTTP/MCP/CLI 适配、runtime/core、全部引擎及浏览器工具。跟踪了所有生产浏览器连接、context/page 创建、HTTP 路由及 Cookie 消费路径。CSDN、知乎通过公共 HTML/Cookie 工具获得同一防护，不需要重复改动引擎。测试专用的原始 context 只用于证明出口层，不作为抓取入口。

本次改造前已有未提交变更；以 [source-before.json](source-before.json) 为本次源码基线，不能用 Git HEAD 代替。改造后快照见 [source-after.json](source-after.json)，改动列表见 [verification.json](verification.json)。未改动资源限制常量、Node 通用 HTTP 实现、依赖锁文件或原审计结论。

基线的 103 个源码文件中，18 个修改、85 个保持不变，另新增 9 个源码文件。[静态及哈希复核](artifact-review.json)记录检查范围；[SHA-256 清单](manifest.sha256.json)覆盖交付源码、部署文件、文档及测试证据。

## 验收矩阵

应用测试使用临时真实 Chromium 浏览器、自建代理和私网 canary。应用测试代理故意允许向 canary 转发，避免出口限制掩盖应用守卫缺失；代理组件另行验证数值 IP 建连。没有访问真实企业内网或使用个人浏览器状态。

| 编号 | 本次证据 | 结论 |
| --- | --- | --- |
| T01 | 主导航、图片、iframe fetch 的多跳重定向；301/302/303/307/308；私网后再跳公网 | 应用测试通过，私网 TCP/HTTP 零命中 |
| T02 | window.open、链接和表单新窗口，直接或经公共地址跳转 | 应用测试通过，首请求阻断并清理页面 |
| T03 | about:blank 弹窗后设置 location | 应用测试通过 |
| T04 | 合法跨站 iframe 正常加载；真实 OOPIF 安装子 session，私网请求被拒绝 | 应用测试通过 |
| T05 | 页面、iframe 的 ws/wss；普通 worker 默认禁止创建 | 没有真实 WS 上游握手；未开放 WS 白名单 |
| T06 | Service Worker API 可用时尝试注册；普通及新 realm 恢复的 worker 构造器 | 无注册、无 worker 脚本请求；普通 worker 被阻止 |
| T07 | 代理先返回公网、后返回私网；混合 IPv4/IPv6、mapped IPv6、空或非法答案、fake-IP 豁免尝试 | 组件测试通过；目标部署 DNS/出口验收待完成 |
| T08 | 真实页面业务路由调用 continue，独立 CDP 仍拒绝直接私网及重定向；生产没有 route.fetch | 应用测试通过 |
| T09 | 必需 API 缺失、创建/注册失败 | 单元测试通过，无导航或默认 context 回退 |
| T10 | 共享初始化 Promise、CDP 脱离、断线及下一次完整初始化 | 单元测试通过；OOPIF 覆盖另有真实浏览器验证 |
| T11 | 提供原始 socket、无应用守卫的浏览器、代理失效及 bypass 验收工具 | 目标网络尚未运行；IPv6 可达 canary 仍需部署 |
| T12 | 恶意无限求值、HTTP 客户端中断、失败清理、取消后延迟返回 context、后续正常任务 | 应用及单元测试通过；失败清理会隔离 endpoint |
| T13 | 普通网页、合法跳转、Cookie、生产 HTML/MCP 工具/HTTP daemon 入口；Bing HTTP 和解析回归 | 本地回归通过；实际 Bing 浏览器流程待部署验证 |
| T14 | 任务间 Cookie 隔离、关闭整个 context；通过 Playwright WS 使用生产入口 | 应用侧通过；远端机器强制出口待验收 |

Service Worker 测试仅对自建 HTTP 测试源启用 Chromium 的 secure-context 测试开关，使 API 可用后再验证实际注册状态；生产启动参数不包含该开关。`register()` 的 Promise 是否拒绝不是通过标准，实际注册、控制状态和脚本请求均须为空。

## 验证结果

- Node `v22.23.3`，Playwright `1.62.1`，浏览器自报版本 `154.0.8037.98`。
- TypeScript 编译成功；23 个测试脚本中 21 个通过、2 个原有失败；没有 SKIP 或新增失败。机器报告的 `passed: 22` 包含编译这一项。
- 浏览器证据：[真实浏览器日志](test-browser-redirect-safety.log)、[防护生命周期](test-browser-network-policy.log)、[容量与隔离](test-page-pool-lock.log)。私网 canary TCP/HTTP 和真实 WS 上游握手计数均为零。
- 代理证据：[HTTP/CONNECT 组件日志](test-browser-egress-proxy.log)。合法数值 IP 测试通过；拒绝目标未调用连接传输，也未增加 canary 命中；目的 IP 决策日志的脱敏测试通过。
- 已执行网页内容、URL/IP、重定向、HTTP 参数、core、CLI、HTTP daemon、MCP、runtime 和 Bing HTTP/解析回归；完整明细见 [verification.json](verification.json)。这不是包含所有外网/live 测试的 `npm test` 全量通过声明。

原有失败为 [test-resource-limits](test-resource-limits.log) 仍要求第五个 MCP session 被拒绝，以及 [test-mcp-resource-limits](test-mcp-resource-limits.log) 断言 `16 !== 4`。本次基线中 `maxMcpSessions=16`、空闲期 5 分钟，而这两项测试仍按 4 个 session / 3 分钟的旧预算编写。相关常量和测试源码均未改动；未为消除失败调整无关预算。

可复验命令：

```sh
npm run test:browser-security
node docs/security/2026-10-11-c03/run-verification.mjs
```

第二条应使用项目要求的 Node 22。日志由每个脚本独立生成；缺少真实浏览器时的 SKIP 不能当作验收通过。

## 部署条件及剩余工作

浏览器任务现在要求 `BROWSER_EGRESS_PROXY_URL` 和 `BROWSER_EGRESS_ENFORCED=true`；缺少时返回 `browser_egress_unverified`。环境变量只表达部署声明，不创建或验证网络策略。每个任务使用全新状态，依赖持久化 profile、worker 或 WebSocket 的站点可能受影响，Bing 浏览器兼容性必须实际确认。

下一步在目标 Docker/远程浏览器主机按 [出口部署与验收说明](../browser-egress.zh-CN.md) 执行网络独立验收，再运行真实公网 HTTPS、Bing 和业务站点回归，保存规则、版本、目的 IP 决策和 canary 计数。此处仅完成部署入口脚本语法及配置文件静态复核，没有执行镜像构建、`docker compose config` 或容器网络测试。

上述证据齐备前不关闭综合 C03；C04 的 Node HTTP 代理分支继续单独跟踪。
