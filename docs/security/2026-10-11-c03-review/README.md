# C03 实现审查记录

后续状态（2026-10-11）：下述 R1/P2 已修复，相关回归验证通过；见 [修复与验证记录](../2026-10-11-c03-p2-fix/README.md)。本页保留原审查结论和失败证据。

审查日期：2026-10-11。范围为 C03 浏览器网络防护及相关调用链、出口代理和部署配置；不是对先前 C01—C09 的重新定级。本次仅新增审查证据，未修改生产源码。

结论：发现一项需要修复的 P2 回归。已执行的安全用例未发现新的私网访问绕过，但尚不能将 C03 综合验收标为完成：需要修复下述正常导航误拦截，并补齐目标部署网络验收和真实业务兼容性证据。

## R1 / P2：主页面正常导航会误触发子 target 防护失效

位置：`src/utils/browserNetworkPolicy.ts:136–138`，`Target.detachedFromTarget` 处理逻辑。

当主页面已加载一个跨站 iframe（OOPIF），随后主页面发生正常导航时，旧 iframe 的 CDP session 会脱离，但此时 `Target.getTargetInfo` 仍可能成功返回旧 target 信息。当前代码把“此刻还能查询到 target”直接判定为“仍在执行却失去防护”，调用 `state.fail()` 关闭整个 context，向业务返回 `browser_guard_lost: Browser child interception detached`。

这会中断包含跨站嵌入内容的页面后续正常跳转，也会影响多步页面交互。已通过生产 `fetchPageHtmlWithBrowser()` 入口复现：测试页面加载跨站 iframe 后，由页面脚本跳到另一个允许的公网 URL，抓取却失败。此处是可用性回归，未观察到私网访问成功。

修复建议：结合 frame、主导航及 target 的生命周期，区分当前文档正常退出导致的 session 脱离与仍属于活动文档的 target 意外丢失守卫；仅凭一次 `getTargetInfo` 成功不足以判定。保留真正失去守卫时终止任务的行为，不应直接删除 fail-closed 检查。补充两组回归断言：正常主导航成功；活动子 target 的守卫被意外解除时任务仍失败且没有后续网络访问。

独立复现结果（所有页面均由本地 fixture 代理生成，无上游连接）：

| 场景 | 结果 |
| --- | --- |
| 跨站 iframe 改为同站 iframe | 通过 |
| 跨站 iframe 改为 about:blank | 通过 |
| 删除跨站 iframe | 通过 |
| 跨站 iframe 加载后，通过 page.goto 导航主页面 | 3/3 返回 browser_guard_lost |
| 跨站 iframe 加载后，通过页面 location.href 导航 | 3/3 返回 browser_guard_lost |
| 生产 HTML 抓取入口访问自动跳转测试页面 | 3/3 返回 browser_guard_lost |

证据：[复现程序](./probe-frame-lifecycle.mjs)、[完整结果](./probe-frame-lifecycle.log)。程序结束码为 1，表示符合正常行为预期的导航被错误中断。

运行方式（先构建，使用项目要求的 Node.js 版本）：

```sh
node node_modules/typescript/bin/tsc --pretty false
node docs/security/2026-10-11-c03-review/probe-frame-lifecycle.mjs
```

## 独立验证与边界

Node.js v22.23.3、Playwright 1.62.1、Chromium 154.0.8037.98。独立构建成功；已有 23 个相关测试中 21 个通过、2 个既有失败，无浏览器测试跳过。上述 R1 来自额外编写的探针，不在原有测试覆盖范围内，不能由原有测试通过推断其不存在。

通过的用例包括 context 初始化和失败关闭、WebSocket 拦截、跨进程容量、代理数值 IP 建连、逐跳重定向、弹窗首请求、子资源、OOPIF、worker、Cookie 隔离、生产 MCP/daemon 入口、客户端取消与恶意页面求值超时。真实浏览器安全测试中的私网 canary 收到的 TCP 连接和 HTTP 请求均为零，WebSocket 上游握手为零。

两项既有失败分别是 `test-resource-limits` 与 `test-mcp-resource-limits`：测试预期最多 4 个 MCP session，当前实现为 16。该差异在 C03 开发前的审计和开发验证中已存在，本次没有将其作为新增 C03 缺陷。

完整原有测试记录：[verification.json](./verification.json)。独立复跑脚本：[run-verification.mjs](./run-verification.mjs)。复跑前后 source hash 无变化。

部署配置仅完成静态审查。本机没有可用 Docker 环境，未执行 Linux 容器启动、iptables/ip6tables、禁止浏览器直连、代理故障不回退和远程浏览器出口验收；也未执行真实公网 HTTPS/Bing 兼容性测试。现有 `BROWSER_EGRESS_ENFORCED=true` 是运维声明，不能替代上述实际证据。相关验收步骤见 `docs/security/browser-egress.zh-CN.md`。
