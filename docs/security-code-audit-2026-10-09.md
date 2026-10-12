# open-websearch 代码安全审计报告

审计日期：2026-10-09（Asia/Shanghai）  
项目：D:/fosun/open-webSearchEE，open-websearch 2.2.0  
基准提交：7b348d9349de72404fea5c9eea4a7f542622984c  
执行环境：Windows、Node.js v22.23.2、npm 10.9.8

## 结论

发现 9 项应用代码与配置问题：5 项高风险（均在下表标明实际触发条件）、3 项中风险、1 项低风险。优先处理 HTTP 访问控制、浏览器 SSRF、代理目的地址校验和跨域 Cookie 转发。这些问题可以相互叠加：未认证调用者可以调用抓取功能，再触发浏览器或代理出网缺口。

npm 审计另报告 10 个生产依赖包有告警：7 个 high、3 个 moderate、0 个 critical，共涉及 55 条不同公告。依赖包数量、公告数量和上述应用问题数量是不同统计口径；不能将依赖告警全部视为当前项目可利用的漏洞。

构建通过，选取的 20 项现有回归测试全部通过；新增的隔离复现仍证实了未被这些测试覆盖的安全边界缺口。此次仅增加审计报告与证据，未修复业务代码。

| 编号 | 风险 | 问题 | 触发条件与证据 |
| --- | --- | --- | --- |
| A01 | 高 | MCP HTTP 服务无认证，默认监听所有接口 | HTTP 端口对攻击者可达；未认证初始化及工具发现已复现 |
| A02 | 高，有条件 | MCP 与本地 daemon 不校验 Host / Origin | 浏览器允许访问本地网络时存在 DNS 重绑定入口；非法 Host / Origin 被接受已复现，完整浏览器重绑定攻击未执行 |
| A03 | 高，有条件 | 浏览器导航守卫遗漏重定向与弹窗首请求 | 启用浏览器抓取，浏览器网络策略允许该请求；真实 Chromium 下三条遗漏路径均访问了私网测试服务 |
| A04 | 高，有条件 | 代理请求的 DNS 预检与实际连接脱节；掘金路径遗漏逐跳 DNS 校验 | 使用代理，目的域名解析结果不一致；掘金变体还需要上游可控重定向；均在本地代理夹具复现 |
| A05 | 高，有条件 | 手动跨域重定向保留 Cookie 等敏感头 | 源请求带敏感 Cookie，源站能跳转到攻击者站点；使用虚构 Cookie 已复现 |
| A06 | 中 | 搜索执行放大及会话、浏览器池容量无上限 | 256 个重复引擎、limit=1，实际调用 256 次 executor；其他容量缺口经源码确认 |
| A07 | 中 | 专用抓取路径缺少统一超时、响应体限制 | 大响应或慢上游；模拟 CSDN 响应超过 2 MiB 仍返回 |
| A08 | 中 | 代理密码与远程浏览器令牌写入日志和错误文本 | 配置 URL 含凭证；虚构密码/令牌写入 stderr 已复现 |
| A09 | 低，待确认有效性 | 源码内硬编码 Cookie 与 CSRF 值 | 静态发现；未验证有效性或其是否关联有效登录会话 |

## 范围与方法

盘点 96 个 TypeScript 文件（含测试），重点追踪 57 个非测试文件中的入口、参数验证、网络请求、代理、DNS、重定向、浏览器、Cookie、日志和资源生命周期；同时检查 package.json、package-lock.json、Docker、Compose、GitHub Actions 和敏感信息模式。

完成以下验证：

- npm ci --ignore-scripts --no-audit --no-fund；npm run build 通过。未更改依赖锁文件。
- npm audit --package-lock-only --json 与生产依赖审计，保留原始 JSON。
- 20 项有针对性的回归测试，见 [测试结果](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/regression-results.json)。
- 真实隔离浏览器、本地 HTTP / CONNECT 代理、本地 MCP / daemon、替换上游响应的资源测试。
- 静态检索与手工数据流检查；未运行 Semgrep、CodeQL、Gitleaks 或容器镜像扫描工具。

复现使用独立临时浏览器与审计自建的 loopback 服务，不使用个人浏览器或真实登录 Cookie，不探测企业私网或云元数据。公网源站通过测试 DNS hook / 浏览器 host 映射模拟；这是应用防护机制的验证，不是生产网络的端到端渗透测试。浏览器版本为 Edge / Chromium 154.0.4258.62。

开始审计时 README.md 已有未提交修改；整理报告时 docs/security/ 已有其他未跟踪资料。这些内容均保留。证据保存于本报告同名目录；[复现说明](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/README.md)与 manifest.json 描述执行环境及文件摘要。

## A01：未认证的 MCP HTTP 服务暴露于所有接口

**位置：** [HTTP 入口](D:/fosun/open-webSearchEE/src/index.ts:93)、[初始化处理](D:/fosun/open-webSearchEE/src/index.ts:118)、[监听地址](D:/fosun/open-webSearchEE/src/index.ts:262)、[默认启用 HTTP](D:/fosun/open-webSearchEE/src/config.ts:73)、[Compose 端口与 CORS](D:/fosun/open-webSearchEE/docker-compose.yml:10)。

MODE 未设置时会启用 HTTP；app.listen 绑定 0.0.0.0。/mcp、/sse、/messages 均没有认证或调用者授权检查。新客户端能自行获取 session ID，因此随机 UUID 不能充当访问认证。Compose 将 3000 端口发布到所有接口，并启用通配 CORS。

**影响：** 能连接该端口的调用者可使用注册的搜索、网页抓取和浏览器资源；与 A03/A04 叠加时可能触达部署机器可访问的内部服务。是否可从互联网访问仍取决于防火墙、网络和反向代理，未检查线上部署。

**复现：** 无 Authorization，携带外部 Host / Origin 的初始化返回 200 并创建会话；随后 tools/list 返回 200，包含 fetchWebContent。记录见 [adapter-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/adapter-probes.json)。本次动态验证了初始化和工具发现；工具可被未认证调用的结论同时基于其后没有授权检查的调用链。

**建议：** 默认监听 loopback，远程监听显式开启；在所有 HTTP / SSE 入口统一认证、授权和配额。外部部署可通过受控反向代理认证，但后端端口必须隔离，不能绕过代理直接访问。仅允许必要的 CORS 来源；CORS 不能代替认证。

## A02：缺少 Host / Origin 校验的本地网络入口

**位置：** [MCP transport 配置](D:/fosun/open-webSearchEE/src/index.ts:131)、[daemon 中间件](D:/fosun/open-webSearchEE/src/adapters/http/localDaemon.ts:168)、[daemon 默认监听](D:/fosun/open-webSearchEE/src/adapters/http/localDaemon.ts:44)。

MCP transport 中 DNS rebinding protection 仅作为注释，未启用 allowedHosts / allowedOrigins。本地 daemon 默认绑定 127.0.0.1，但所有业务路由同样没有 Host / Origin 校验或访问令牌。

**影响：** 在浏览器允许相关本地网络访问的环境中，攻击者可能将其域名解析切换到 loopback，用相同域名请求本地 daemon / MCP。仅绑定 loopback 无法校验请求是否来自可信站点。

**复现边界：** 向隔离 loopback daemon 的 /status、/search，以及 MCP /mcp 发送 Host: attacker.test、Origin: https://attacker.test，均被接受。该证据确认入口检查缺失；没有执行完整浏览器 DNS 重绑定。现代浏览器的本地网络访问限制、HTTPS/HTTP 混合内容策略等可能阻止具体攻击，不能依据此测试断言任意浏览器都可利用。

**建议：** 开启并配置 MCP transport 的 Host / Origin 保护；daemon 使用严格、可配置的 Host 和 Origin 白名单及访问令牌，检查覆盖全部路由。反向代理场景仅信任已指定的代理及转发头。

## A03：浏览器 SSRF 守卫遗漏实际请求

**位置：** [installNavigationGuard](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:169)、[浏览器抓取入口](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:304)、[页面加载后的最终 URL 检查](D:/fosun/open-webSearchEE/src/engines/web/fetchWebContent.ts:285)、[浏览器 context 创建](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:323)。

守卫仅安装 page.route。实际 Chromium 验证显示：

| 测试 | 结果 | 安全含义 |
| --- | --- | --- |
| 主导航 302 到 loopback | 私网测试服务收到 /redirect-target，页面拿到测试标记 | 最终 URL 校验发生在访问之后；外层虽可拒绝返回，私网请求已经发生 |
| 图片资源 302 到 loopback | 私网服务收到 /image-target，主页面 URL 仍为模拟公网域名 | 主页面最终 URL 检查无法发现此类请求 |
| 页面脚本 window.open(loopback) | 私网服务收到 /popup-target 及 favicon 请求 | 弹窗首请求未经过原 page 的守卫 |

原始记录见 [browser-guard-probe.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/browser-guard-probe.json)。测试直接使用项目实际的 installNavigationGuard 与真实浏览器；测试 DNS hook 只对模拟公网源域名返回公网地址，私网 URL 未加入允许列表。

Playwright 官方说明 page.route 的 handler 对重定向只调用首个 URL，且不覆盖弹窗首请求及被 Service Worker 接管的请求。[Page.route 文档](https://playwright.dev/docs/api/class-page#page-route)；[BrowserContext.route 文档](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)。

**影响与限制：** 恶意网页可在浏览器所在机器的网络位置发起额外请求，至少产生盲 SSRF 风险。没有验证私网内容经完整 MCP 工具泄露，也没有验证 Service Worker / WebSocket 变体；后两者属于需要补齐的覆盖范围。真实公网到私网请求还受浏览器版本与本地网络策略影响，本次使用本地映射夹具确认了应用拦截器的遗漏。

**建议：** 将浏览器出网限制下沉到受控代理/网络层，在实际连接时拒绝私网、loopback、link-local，并覆盖所有重定向。同时采用 context 级拦截管理所有页面，阻断或明确处理 Service Worker、弹窗和 WebSocket；独立服务浏览器不连接个人登录 profile。仅将 page.route 换成 context.route 不能完整解决自动重定向和 DNS 检查与连接之间的时间差。

## A04：代理模式的 DNS 校验无法约束实际目标

**位置：** [DNS 预检](D:/fosun/open-webSearchEE/src/utils/urlSafety.ts:79)、[代理替代过滤 agent](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:168)、[预检后传原始域名](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:211)。

assertPublicHttpUrlResolved 检查 Node 的 DNS 结果，但不将通过审核的 IP 绑定到后续连接。代理模式使用 HttpsProxyAgent，将原始 hostname 交给代理解析；代理实际目的 IP 没有受到 request-filtering-agent 的约束。

**复现：** Node 预检为 audit-split.test 返回模拟公网地址，受控 CONNECT 代理将同一域名连接到审计 loopback 服务，请求成功返回私网测试标记。见 [network-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/network-probes.json)，proxy-split-dns。

**条件：** USE_PROXY 开启，且 Node 与代理看到不同解析结果，或攻击者能在检查与代理连接之间改变其域名解析。测试模拟解析分歧，未进行真实权威 DNS rebinding；也不意味着不使用代理的同类请求必然可绕过连接级过滤。

**掘金专用变体：** [fetchJuejinArticle](D:/fosun/open-webSearchEE/src/engines/juejin/fetchJuejinArticle.ts:9)直接使用 axios 自动跟随重定向，没有调用逐跳 DNS 校验。通用 [beforeRedirect](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:158)只检查私网字面量。测试中模拟 juejin.cn 返回到解析为 loopback 的域名的 302：真实文章 URL 校验接受了输入，DNS 预检调用数为 0，返回了私网测试内容。真实利用还要求掘金上游存在攻击者可利用的重定向或其他上游控制，本次未确认真实 juejin.cn 存在开放重定向。

[文章 URL 校验](D:/fosun/open-webSearchEE/src/core/validation/targetValidation.ts:3)只比较 hostname 并在完整字符串中找路径片段，允许 HTTP、非标准端口、userinfo，以及仅在 query / fragment 出现的文章路径。资源测试记录了这类输入。Linux.do 和 GitHub 的后续实现会重建固定 HTTPS URL，不能将其宽松验证直接等同于可控任意协议 SSRF。

**建议：** 代理在实际连接时实施目的 IP 过滤，禁止私网地址和解析变化绕过；统一所有可变目标请求的逐跳校验。文章 URL 使用 HTTPS、预期端口、无 userinfo，并校验 URL.pathname 的真实格式。对 FAKE_IP_CIDRS 等明确配置的例外，在代理真实转发目标处保留相同私网限制。

## A05：手动重定向跨域转发敏感头

**位置：** [重复沿用原请求选项](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:214)、[Location 切换](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:228)、[网页抓取 Cookie](D:/fosun/open-webSearchEE/src/engines/web/fetchWebContent.ts:244)、[浏览器 Cookie 后发 HTTP](D:/fosun/open-webSearchEE/src/engines/web/fetchWebContent.ts:373)、[CSDN Cookie 请求](D:/fosun/open-webSearchEE/src/engines/csdn/fetchCsdnArticle.ts:16)。

requestWithSafeRedirects 每一跳都展开同一个 options，不比较 origin 或处理敏感头。调用方显式传入的 Cookie 会被发送到不同域名；显式 Authorization、Proxy-Authorization、Host 同样缺少重定向作用域处理。

**复现：** 模拟公网源域名重定向到另一域名，目标服务收到原 Cookie 和 Authorization；全部值均为虚构审计数据。见 network-probes.json 中 cross-origin-sensitive-header-forwarding。当前公开工具并不接收用户传入的 Authorization，该项证明的是 helper 的头转发行为；实际已存在的敏感数据路径主要为 Cookie。

**影响与条件：** 若原请求带登录/鉴权 Cookie，且源站存在可控重定向，会泄露到新站点。匿名反爬 Cookie 的影响较小；没有验证真实 Cookie 泄露或接入个人登录浏览器。HTTP 降级时还可能失去原 cookie 的 Secure 约束，因为它已被拼接成普通请求头。

**建议：** 每跳重新构建请求头；跨 origin 移除所有敏感头和原 Host；Cookie 使用遵循 Domain / Path / Secure 的 cookie jar，不能把整段 Cookie 无条件复用。带敏感凭证时拒绝 HTTPS 到 HTTP 的降级。补充跨域、跨端口、降级及同源跳转的测试。

## A06：单请求执行放大和无容量上限

**位置：** [MCP engines 数组](D:/fosun/open-webSearchEE/src/tools/setupTools.ts:108)、[daemon 参数解析](D:/fosun/open-webSearchEE/src/adapters/http/localDaemon.ts:72)、[逐项并发执行](D:/fosun/open-webSearchEE/src/core/search/searchService.ts:51)、[MCP 会话映射](D:/fosun/open-webSearchEE/src/index.ts:111)、[页面池持续创建](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:607)、[Cookie 缓存写入](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:290)。

engines 不去重、没有元素数量上限。分配到 0 的 engineLimit 仍调用 executor；最终截断返回结果不限制后台任务数。测试使用真实 daemon 参数解析及搜索服务，把外部 executor 替换为计数夹具：limit=1、256 个重复 exa，HTTP 200，executorCalls=256。没有向第三方实际发出 256 次请求。

此外，会话无 TTL/数量配额，HTTP 响应结束不自动销毁 MCP 会话；页面池遇到忙页面会继续创建，无全局页数上限；releasePage 只释放占用标记，未清空当前网页的后台脚本；Cookie 缓存过期检查不删除其他过期 key，缺少总容量限制。这些生命周期问题由源码确认，未进行耗尽内存的压力测试。

**影响：** 可放大请求、浏览器进程内存和网络开销，造成服务降级或资源耗尽。express.json 的默认请求体上限仍存在，因此这里不是“无限大 JSON 请求体”漏洞。

**建议：** 引擎数组去重并设置合理上限；engineLimit=0 时跳过调用；设置请求/全局并发、页面数、会话数和缓存容量上限，增加 TTL/LRU。请求取消时取消后台任务，归还页面时停止残留脚本及关闭衍生弹窗。接入认证和按调用者配额。

## A07：专用抓取缺少一致的时间与响应体预算

**位置：** [CSDN](D:/fosun/open-webSearchEE/src/engines/csdn/fetchCsdnArticle.ts:16)、[Linux.do](D:/fosun/open-webSearchEE/src/engines/linuxdo/fetchLinuxDoArticle.ts:14)、[掘金](D:/fosun/open-webSearchEE/src/engines/juejin/fetchJuejinArticle.ts:25)、[GitHub](D:/fosun/open-webSearchEE/src/engines/github/github.ts:79)、[浏览器加载后的大小检查](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:384)。

通用网页 HTTP 抓取已设置 20 秒和 2 MiB 限制，但专用抓取路径不一致：

| 抓取器 | 实际配置超时 | 响应体上限 |
| --- | --- | --- |
| CSDN | 0，无 Axios 超时 | -1，无限额 |
| Linux.do | 0，无 Axios 超时 | -1，无限额 |
| 掘金 | 30 秒 | -1，无限额 |
| GitHub README | 10 秒 | -1，无限额 |

资源夹具替换上游 Axios 响应，捕获真实请求选项；CSDN 返回 2,098,176 个内容字符，超过通用网页限制。该测试验证配置与解析路径，不是实际大流量/OOM 攻击。见 [resource-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/resource-probes.json)。

浏览器的 HTML 大小限制在页面加载/等待之后检查，不能限制已下载的图片、脚本和渲染成本。DNS 检查及多跳/重试也需要纳入整体截止时间。

**建议：** 所有网络入口统一默认超时、下载字节上限及解压后大小上限，设置含 DNS、重定向、重试、浏览器等待的绝对截止时间，结合 A06 的并发预算。浏览器需要网络与页面运行预算，不能只限制最终提取文本。

## A08：配置凭证泄露到日志和错误

**位置：** [代理 URL 日志](D:/fosun/open-webSearchEE/src/config.ts:173)、[浏览器端点日志](D:/fosun/open-webSearchEE/src/config.ts:191)、[WS 连接错误](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:2335)、[CDP 连接错误](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:2350)、[工具错误回传](D:/fosun/open-webSearchEE/src/tools/setupTools.ts:344)。

完整 PROXY_URL 和 PLAYWRIGHT_WS_ENDPOINT / PLAYWRIGHT_CDP_ENDPOINT 被打印。URL userinfo 中的密码、路径或 query 中的访问令牌会进入日志；连接失败错误也拼接完整端点，可沿工具/daemon 错误响应返回。

**复现：** 在独立配置子进程注入虚构代理密码和 token，确认 stderr 同时包含两者。没有使用真实凭证。错误响应泄露路径经源码确认，本次未模拟真实远程浏览器连接失败并截获客户端响应。

**建议：** 统一 URL 脱敏，删除 userinfo 并屏蔽敏感路径/query；外部响应使用概括性错误，详细诊断也必须脱敏，避免底层错误再次包含完整 URL。

## A09：硬编码 Cookie / CSRF 值

**位置：** [CSDN 搜索 Cookie](D:/fosun/open-webSearchEE/src/engines/csdn/csdn.ts:19)、[Linux.do 请求头](D:/fosun/open-webSearchEE/src/engines/linuxdo/fetchLinuxDoArticle.ts:31)。

源文件包含固定 Cookie 和 x-csrf-token 等值。未测试其是否有效，也未确认是否关联可登录账户，因此归为低风险凭证管理问题，不作有效账户泄露结论。报告和证据不复制这些原始值。

**建议：** 移除固定会话值，匿名请求按需获取并控制作用域；若必须注入凭证，使用部署环境的秘密管理机制。只有确认仍有效的敏感凭证才需要撤销/轮换。静态模式扫描未发现其他明确的私钥、AWS access key 或 GitHub token 命中，这不构成不存在秘密的保证。

## 依赖审计与可达性

以下为锁文件实际版本，不是 package.json 的版本范围。完整公告见 [dependency-summary.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/dependency-summary.json)；原始数据见 [完整 npm audit](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/npm-audit.json)及[生产 npm audit](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09/npm-audit-production.json)。

| 包 | 锁定版本 | npm 风险 | 修复方向 | 当前调用链判断 |
| --- | --- | --- | --- | --- |
| request-filtering-agent | 3.2.0 | high | ≥3.2.1 | 直接使用；公告的字面量私网 IP 触发条件受到现有前置验证/跳转钩子限制，未复现崩溃 |
| @modelcontextprotocol/sdk | 1.27.1 | high | ≥1.31.0 | 本项目使用 MCP server；本次公告针对 OAuth client |
| hono | 4.12.7 | high | ≥4.13.7 | SDK 的传递依赖；项目 HTTP 入口为 Express，未发现 Hono 特定受影响接口使用 |
| @hono/node-server | 1.19.11 | moderate | ≥1.19.15 | 未使用其静态文件服务路径 |
| ip-address | 10.1.0 | high | 升级至超出公告 ≤10.7.0 范围的修复版本 | 由 express-rate-limit 引入；本项目 IP 校验使用 ipaddr.js，不能混淆 |
| express-rate-limit | 8.3.1 | moderate | 更新其传递依赖 | 没有独立公告；本次告警由 ip-address 传递 |
| path-to-regexp | 8.3.0 | high | 8.x ≥8.4.0 | Express router 引入；当前路由为固定路径，未发现公告要求的路由模式 |
| qs | 6.15.3 | moderate | ≥6.16.0 | 未发现受影响的解析选项/调用路径；Express 5 默认 simple query parser |
| undici | 6.24.0 | high | 6.x ≥6.28.1 | Cheerio 传递依赖；当前使用 cheerio.load，未发现受影响的 undici 功能调用 |
| ws | 8.18.2 | high | 8.x ≥8.21.0 | 经 jsdom 引入；未发现暴露 ws server 或执行 jsdom WebSocket 的路径 |

request-filtering-agent 公告说明字面量私网 IP 可导致同步异常退出：[GHSA-r3r9-wp5j-pq5g](https://github.com/advisories/GHSA-r3r9-wp5j-pq5g)。现有字面量前置验证并不免除升级必要，但此项不能宣称已在当前项目成功利用。

MCP SDK 公告明确涉及 OAuth client，而非 MCP server：[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h)。

以上“未发现可达”基于当前调用链，不保证未来配置/代码变化或所有依赖初始化路径不可达。Node 原生 fetch 使用运行时内置实现，其风险不能直接等同于锁文件 npm undici 版本。建议更新锁文件并执行构建、代理/重定向/浏览器回归，然后复查 npm audit；此次没有执行 npm audit fix。

## 其他部署与供应链加固项

- [Dockerfile](D:/fosun/open-webSearchEE/Dockerfile:2)使用 Node 20。以审计日期计，Node 20 已于 2026-04-30 结束支持；迁移至仍受支持的 LTS 并验证 koffi 与浏览器兼容性。[Node 官方发行表](https://nodejs.org/en/about/previous-releases)、[官方生命周期数据](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)。
- [非 Windows 浏览器启动](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:1999)包含 --no-sandbox、--disable-setuid-sandbox 等减弱隔离的参数。接收不可信网页时应尽量恢复 sandbox，并在独立容器/账户中运行。这不是已确认浏览器 RCE，也不将非 Windows 参数套用到 Windows 启动路径。
- [Docker 安装步骤](D:/fosun/open-webSearchEE/Dockerfile:14)在 npm ci 失败后回退 npm install，可能改变锁文件解析；安装保留开发依赖。建议构建失败时明确失败，并使用多阶段构建缩小生产镜像。
- [.dockerignore](D:/fosun/open-webSearchEE/.dockerignore:1)未排除 .env*、密钥文件等，而 Dockerfile 使用 COPY . .。此次未发现这些本地文件被打包的证据；若以后增加，应避免进入构建上下文。
- [CI 工作流](D:/fosun/open-webSearchEE/.github/workflows/docker.yml:30)的 actions 未固定 commit SHA，[镜像](D:/fosun/open-webSearchEE/docker-compose.yml:6)使用 latest，provenance 被关闭。可固定依赖/镜像摘要、最小化 workflow 权限并启用构建来源证明。未认定手工 release_tag 为命令注入：它已有环境变量传递和版本格式检查。
- 浏览器共享 profile 是项目已明确记录的匿名公共抓取设计。它会放大敏感 Cookie 的风险，但此次未将“共享状态”单独计为跨用户数据泄露漏洞。个人登录浏览器接入应遵守该设计边界。

## 修复顺序与验收

1. 先收紧监听地址、HTTP 认证、Host / Origin，并添加按调用者配额。
2. 封闭浏览器和代理实际出网目的地址，覆盖重定向、子资源、弹窗和其他网络通道。
3. 修复敏感头的重定向作用域；统一资源、会话、页面池和缓存预算。
4. 脱敏日志和外部错误，移除固定会话值，更新有告警依赖与过期 Node 镜像。

修复验收至少包括：未认证调用拒绝、异常 Host / Origin 拒绝、浏览器三类私网请求都在访问前阻断、Node/代理解析不一致时拒绝、跨域重定向不携带 Cookie、重复引擎只执行一次且零预算不执行、所有抓取路径遵守时间/字节上限、会话/页面/缓存有确定容量、日志与响应不含虚构凭证。

## 验证限制

没有运行完整在线 npm test / live 集成、生产流量压力测试、真实 DNS 攻击、个人 profile 测试、镜像 CVE 扫描或 Git 全历史秘密扫描。没有确认生产端口暴露、真实掘金开放重定向、硬编码 Cookie 有效性、浏览器 RCE 或私网数据经最终工具泄露。审计结果针对上述提交及当前源码快照；源码 SHA-256 见 manifest.json。源代码检查与现有测试通过均不能证明不存在其他漏洞。
