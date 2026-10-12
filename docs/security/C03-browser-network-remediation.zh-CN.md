# C03 综合解决方案：浏览器网络访问边界

整理日期：2026-10-11（Asia/Shanghai）  
状态：已完成代码实现及应用/代理组件验收；目标部署网络与实际 Bing 兼容性待验收，尚未整体关闭。  
实施记录：[2026-10-11 C03](2026-10-11-c03/README.md)；[出口部署说明](browser-egress.zh-CN.md)。  
依据：[2026-10-10 审计报告](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10.md)及 [真实浏览器验证记录](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/browser-probes.json)。

**核心决策：使用任务专用 BrowserContext，先安装统一防护再创建页面；默认拒绝弹窗和 WebSocket、阻止 Service Worker；保留 CDP 逐跳检查，并由受控代理和浏览器所在网络的出站限制约束实际连接。防护初始化或运行中失效时，终止任务并回收所属资源。**

**1. 目标与完成边界**

C03 的直接问题是：守卫只绑定当前 page，恶意网页的弹窗首请求和 WebSocket 能访问浏览器所在网络的内部服务。已有测试确认主导航和图片重定向已被拦截，应保留这些能力并补齐旁路。

修复目标为：主页面、iframe、子资源、弹窗及 worker 的网络活动均受明确策略约束；禁止地址不能收到连接或请求。抓取最终报错、最终 URL 合法、事后关闭弹窗，都不能替代“请求发出前拦截”的验收。

| 工作范围 | 本方案要求 |
| --- | --- |
| C03 应用代码 | Context 级 HTTP 检查；弹窗、WebSocket、Service Worker 策略；逐跳检查；统一生命周期与失败处置 |
| 浏览器实际出口 | 受控代理校验并连接具体目的 IP；浏览器不能绕过代理。这也是 C04 浏览器分支的必要修复 |
| C04 Node HTTP 分支 | Node 使用的代理同样需要执行实际目的地址限制；仅完成浏览器方案不能关闭整个 C04 |
| 资源回收 | 为本任务操作与清理设置期限；与 C07 的整体期限修复衔接，避免失败后遗留页面、worker 或容量占用 |

应用侧改造与出口部署可以分别交付、分别记录验证结果，但整体方案验收前不能声明“所有浏览器网络访问均受保护”。

**2. 建立唯一的受控 context 创建入口**

新增统一的 context/session 工厂，由网页抓取、Cookie 采集和相关浏览器任务调用。第一版建议复用浏览器进程，每个任务创建独立 context，任务结束关闭该 context；避免跨任务遗留脚本、worker、连接和登录状态。

创建时设置 `serviceWorkers: 'block'`，并保持正常的页面安全默认值。需要登录状态时，按任务和目标站点显式注入获授权的状态，不通过接管个人或来源不明的默认 profile 获得 Cookie。

禁止在新 context 创建失败、防护注册失败后回退到 `browser.contexts()[0]` 或隐式 `browser.newPage()`。默认 context 和已有页面可能已产生网络活动，也可能已经存在连接；事后添加路由不等于它们从创建起就受保护。Playwright 的 Service Worker block 选项限制注册，清 Cookie 不具备等价效果。[创建 context 及 Service Worker 选项](https://playwright.dev/docs/api/class-browser#browser-new-context-option-service-workers)。

当前页面池若需要保留，应调整为管理“本服务创建且防护就绪的任务资源”，不能自动吸纳既有 context/page。后续若优化为 context 池，必须另行证明跨任务状态和后台网络活动已可靠清除；第一版不以共享 context 复用换取兼容。

**3. 统一 HTTP/HTTPS 请求检查，并处理路由优先级**

创建 context 后，先注册覆盖全部 URL 的 `context.route('**/*', ...)`，再创建页面。HTTP 检查使用同一策略模块，覆盖导航和非导航请求；页面来源是否获授权与目标地址是否允许是两项独立判断。

现有 `page.route` 优先于 context 路由，而 `route.continue()` 会跳过后续匹配处理器。因此，应将当前页面守卫中的通用 HTTP 检查迁移到 context；确需保留的业务路由使用 `route.fallback()`，最终由统一安全处理器校验后发送。其他 context 业务路由也不得独立绕过安全处理器发网；请求改写后的实际目标必须重新校验。CDP 检查作为独立一层保留。[Context 路由优先级](https://playwright.dev/docs/api/class-browsercontext#browser-context-route)、[continue 与 fallback](https://playwright.dev/docs/api/class-route#route-continue)。

统一地址策略至少包括：

- 对应用主动打开的网络 URL 只允许 HTTP/HTTPS；拒绝非预期协议及带 userinfo 的 URL。`about:blank`、`data:`、`blob:` 按明确的本地资源规则分类，其产生的后续网络请求仍必须检查。
- 使用可靠的 URL/IP 解析，规范化 hostname、端口、IPv4、IPv6 及 IPv4-mapped IPv6；域名白名单使用规范化后的精确匹配规则。
- 解析并检查所有 A/AAAA 结果；解析失败、无法识别的地址或存在禁止结果时拒绝。按请求及每次新连接校验，不能缓存“此域名永久安全”的判断。
- 沿用项目现行必禁范围，包含整个 `10/8`、`127/8`、`172/8`、`192/8` 及对应 mapped IPv6；同时按现行策略拒绝 loopback、link-local、其他非公网地址。不得将前述范围缩小成 RFC1918 子集。
- 白名单及 `FAKE_IP_CIDRS` 不能豁免项目必禁范围。使用合成 DNS 时，出口仍要验证真实最终目标，不能把合成地址通过预检视为最终目的安全。
- 明确允许的目标端口，第一版建议默认 80/443；确需其他端口时显式配置并执行相同 IP 限制。

Node 中的这些检查用于提前拒绝和一致报错；实际连接地址由第 7 条的出口边界进一步约束。

**4. 在首请求发出前拒绝未授权页面**

只允许由服务主动创建、完成防护准备的页面发起网络活动；页面授权记录只能由受控工厂写入。`context.on('page')` / `page.on('popup')` 用于发现、记录和清理意外页面，不得自动将新页面加入允许集合。

Context 请求处理器应在放行前判断请求归属。对于未授权页面的首导航及后续资源请求，一律中止；同时保留获授权主页面中合法 iframe 的业务能力。不能把所有 `isNavigationRequest()` 都当成弹窗，否则会误拦 iframe。

部分首导航发生时 frame 尚不存在，`request.frame()` 可能抛错。处理器必须明确捕获这种情况；无法可靠确认归属时拒绝，不得通过异常兜底继续请求。[Request.frame 文档](https://playwright.dev/docs/api/class-request#request-frame)。

覆盖 `window.open(url)`、`target="_blank"`、表单新窗口，以及先创建 `about:blank` 再设置 location 的变体。仅覆盖页面中的 `window.open` 函数不作为安全边界。

**5. 默认关闭额外网络通道**

| 通道 | 默认策略 | 确需支持时的条件 |
| --- | --- | --- |
| 弹窗 / 额外页面 | 请求前拒绝，事件回调负责后续清理 | 由受控工厂明确创建并授权，不能接管未知弹窗后自动放行 |
| WebSocket | 创建页面前注册全匹配 `context.routeWebSocket`；不连接真实上游并关闭被拦截连接 | 检查规范化后的 `ws/wss`、主机、端口和地址；通过受控出口连接；白名单不能豁免私网限制 |
| Service Worker | 新 context 设置 `serviceWorkers: 'block'` | 本次抓取方案不开放；后续有需求需单独设计其网络覆盖 |
| Dedicated / Shared Web Worker | 不因来源为 worker 自动放行，HTTP、WebSocket 采用相同目标限制 | 无法可靠归属或应用拦截不覆盖时默认拒绝；保留 worker 功能必须有出口约束及专项测试 |
| WebRTC / QUIC 等非 HTTP 网络活动 | 不需要的功能关闭，网络层拒绝不必要的 UDP / 直接出站 | 显式定义独立出口规则，不以 HTTP 代理配置代替 |

`routeWebSocket` 只影响注册后创建的连接；匹配到的连接默认不建立真实上游连接。必须覆盖 `ws:` 和 `wss:`，不能仅对某个业务路径安装规则。异步校验未完成前不能调用建立上游连接的方法。[WebSocket 路由时机](https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket)、[默认连接行为](https://playwright.dev/docs/api/class-websocketroute#web-socket-route-connect-to-server)。

普通 Web Worker 与 Service Worker 是不同机制。设置 `serviceWorkers: 'block'` 不意味着普通 worker 已被禁用，也不意味着其全部网络活动已由某个 page 的拦截器覆盖。

**6. 保留逐跳拦截，明确 CDP 的覆盖范围**

保留当前 CDP `Fetch.requestPaused` / `Fetch.enable` 请求阶段检查，按每跳 URL 校验后继续或失败。Context 路由负责统一入口和页面归属，CDP 逐跳检查与网络出口负责补足不能仅靠 route 证明的覆盖。

当前 `newCDPSession(page)` 仍是对指定页面建立 session，不能据此假设新 target、跨进程 iframe 或 worker 都已获得相同逐跳保护。实施时需对这些 target 单独验证；必要的附着和检查必须先于它们的网络活动。不要在发现新 target 后立即恢复执行、随后再异步安装防护。

第一版保持当前 Chromium/CDP 能力要求。若不能证明某类 target 的应用侧覆盖，默认不开放该类功能，并由出口继续保证禁止地址不可达；不降级到仅检查最终 URL。任何 target 管理改动需验证不会破坏 Playwright 自身的会话管理。

**7. 用实际出口校验约束浏览器连接**

目标链路：

```text
任务专用 BrowserContext
  → HTTP / WebSocket / 逐跳应用检查
  → 浏览器所在机器的强制出站策略
  → 受控代理：解析、校验、连接已验证 IP
  → 允许的公网目标
```

代理必须在真正创建 TCP 连接的一侧解析 A/AAAA、识别 IPv4/IPv6、执行禁止网段与端口规则，并直接使用通过校验的具体 IP 建连；重试、重新解析、每次新 CONNECT 都执行相同校验。不能先检查一次域名，再把原域名交给另一层重新解析。HTTPS 保留正确的目标 hostname / TLS SNI 和证书验证。

浏览器部署环境只允许必要的代理连接及受控的管理 / DNS 通道，拒绝绕过代理直连其他 TCP/UDP 目的地；明确覆盖 IPv6、loopback、link-local 和容器 / 宿主网段。控制通道例外必须限定地址、端口和方向，不能成为网页可任意利用的放行规则。代理自身的出口也应拒绝禁止地址。

禁止代理失败后回退 DIRECT，检查 PAC、代理 bypass 和浏览器启动参数。Chromium 存在 localhost/link-local 隐式绕过规则；需结合实际启动配置和网络策略消除可达旁路，不能只设置一个代理 URL。[Chromium 隐式绕过规则](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#implicit-bypass-rules)。

同一机器上默认放行 loopback 的防火墙规则不能被视为已满足本要求；独立容器 / 网络命名空间内也不能放置网页可达的敏感管理服务。远程 WS/CDP 模式必须在远程浏览器所在机器或出口部署限制，Node 所在机器的防火墙不能代替远端约束。

如远程浏览器供应方不能提供或验证上述能力，严格抓取模式应拒绝使用该连接，而不是把应用 DNS 预检作为等价替代。

**8. 生命周期、就绪状态和失败处置**

每个任务采用统一流程：

```text
预留抓取 / 浏览器容量
  → 获取浏览器并校验实际客户端与连接能力
  → 创建任务 context（阻止 Service Worker）
  → 注册 HTTP / WebSocket 规则和故障监听
  → 创建空白页面并记录任务所有权
  → 安装 CDP 逐跳检查
  → 所有必要步骤成功，标记页面 ready
  → 导航、抓取
  → 关闭任务 context，释放锁、句柄和容量
```

能力检查包括实际加载模块的 API、连接方式和注册是否成功；不能只查看 package-lock 中的版本。远程供应方的能力还需要部署及验收证据，不能凭一次 API 调用成功推断出口已受限。

就绪状态应绑定本次 browser connection、context 和页面的具体实例。不能仅凭曾经进入 WeakSet 或池条目的 `prepared=true` 认定重连后的实例仍安全。防护只注册一次，但所有使用者必须等待同一初始化 Promise 完成；并发创建不能提前取得未就绪资源。

| 失败场景 | 必须执行的动作 |
| --- | --- |
| Context / HTTP / WebSocket / CDP 初始化失败 | 不导航，销毁本任务已创建资源，释放预留容量，不回退默认 context |
| DNS 校验失败或单条目标违规 | 中止该请求；不能因处理异常而 continue，也不能改走未受控通道 |
| 必要 CDP session 脱离、拦截机制失效 | 标记任务资源不可用，停止任务并回收；不返回可继续复用的池条目 |
| 浏览器断线或崩溃 | 当前任务失败；重新连接后创建新的受控 context 并完整初始化，有限重试 |
| 任务期限到达、取消或客户端中断 | 主动关闭所属 context 以停止页面 / worker，执行有期限的清理 |
| 清理无法完成 | 隔离故障资源；仅对本服务拥有的专用 browser worker 执行升级回收，不终止他人共享浏览器 |

整体期限覆盖初始化、导航、求值、内容读取与清理。只用 Promise.race 返回超时而留下后台页面不足以回收资源；应与 C07 的操作取消与故障 worker 回收保持一致。错误输出使用稳定代码和脱敏原因，不泄露远程 endpoint 凭据。

**9. 当前项目改造清单**

| 位置 | 改造要求 |
| --- | --- |
| 建议新增 `src/utils/browserNetworkPolicy.ts` | 统一目标及通道策略、受控 context 初始化、任务页面登记、ready / invalid 状态；接口名称可调整 |
| [browserCookies.ts](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts) | 将通用 page.route 检查迁至 context 工厂；保留独立的 CDP 逐跳检查；消除路由优先级旁路 |
| [browserCookies.ts](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts) | Cookie 采集通过受控工厂创建 context；移除未受控默认 context 回退 |
| [browserCookies.ts](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts) | HTML 抓取只能获取 ready 的任务资源；纳入整体取消与清理 |
| [playwrightClient.ts](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts) | 增加创建页面前的 context 准备接口；不能只依赖事后 preparePage |
| [playwrightClient.ts](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts) | 池的策略不可被首次调用参数隐式固定；安全策略不匹配时拒绝共享 |
| [playwrightClient.ts](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts) | 不自动吸纳默认 context / 既有页面；受保护任务使用专用 context 与全局容量控制 |
| [playwrightClient.ts](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts) | 恢复连接后完整重建防护，禁止沿用旧 ready 标志 |
| [bing.ts](D:/fosun/open-webSearchEE/src/engines/bing/bing.ts) | 已有 preferExistingContext=true 需专项兼容验证；需要持久化登录时使用专用、由服务从启动起控制的浏览器方案，不作为任意网页抓取的回退入口 |
| [urlSafety.ts](D:/fosun/open-webSearchEE/src/utils/urlSafety.ts) | 保持必禁网段一致，为代理侧策略提供同一基线和一致性测试 |
| [test-browser-redirect-safety.ts](D:/fosun/open-webSearchEE/src/test/test-browser-redirect-safety.ts) | 保留重定向回归，加入真实浏览器弹窗 / WebSocket / target 验证；不只断言 route 注册次数 |
| 浏览器 worker、代理及部署配置 | 强制出口、无 DIRECT 回退、远端网络约束及可观测性 |

改造前，页面池默认倾向已有 context，且 Cookie 采集有默认 context 回退。本次已通过统一工厂移除这些路径。仅给调用增加 `serviceWorkers: 'block'` 或 `preferExistingContext: false` 还不够；context 必须在任何页面创建之前完成防护，相关恢复与复用路径也必须执行同一工厂。

**10. 验收矩阵**

所有禁止地址验证都以自建私网 canary 的实际 TCP / HTTP / WebSocket 记录为依据，同时记录代理的目的 IP 决策。不能只检查页面错误或工具返回值。测试使用临时隔离浏览器、虚构凭据和自建服务，不访问真实企业内网。

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| T01 | 主页面、图片、XHR 经多级重定向到私网，再返回公网 | 任一禁止跳转均在访问前拒绝，私网 canary 零命中 |
| T02 | window.open、target=_blank、表单新窗口直接或经公网跳向私网 | 首请求及后续请求均被阻断，意外页面被清理 |
| T03 | 先打开 about:blank，再设置 location 或运行请求脚本 | 未授权页面不获得网络权限，私网零命中 |
| T04 | 同站 / 跨站 iframe，包括跨进程 iframe 的私网请求与重定向 | 禁止目标零命中，合法公网 iframe 可用 |
| T05 | 主页面、iframe、Dedicated / Shared Worker 发起 ws / wss | 默认没有真实上游握手；开放白名单后禁止地址仍零命中 |
| T06 | 注册 Service Worker；普通 worker 使用 fetch、XHR 或导入脚本 | Service Worker 注册被拒绝；worker 不产生绕过边界的访问 |
| T07 | Node 预检为公网，浏览器 / 代理解析为私网；混合 A/AAAA、mapped IPv6 | 实际连接被拒绝，禁止地址零命中 |
| T08 | 现有 page.route 或其他业务路由匹配同一请求 | 统一安全处理器仍必经，无 continue / route.fetch 发网旁路 |
| T09 | 缺少 routeWebSocket、CDP 不支持、任一步骤注册抛错 | 页面未导航，资源及容量恢复，无默认 context 回退 |
| T10 | 注册期间并发获取、CDP 中途脱离、浏览器断线后重连 | 不交付半初始化资源；失效资源不回池；重连重新安装全部防护 |
| T11 | 代理故障、localhost/link-local bypass、IPv6 直连、非必要 UDP | 无 DIRECT 或其他可达旁路；禁止服务零连接 |
| T12 | 任务超时、取消、清理异常及后续正常抓取 | 后台活动停止；锁与容量可回收；后续合法请求成功 |
| T13 | 普通公网网页、合法重定向、Cookie 采集、Bing 兼容流程 | 核心功能正常，无依赖未受控回退的成功路径 |
| T14 | 任务 A 结束后创建任务 B；远程浏览器部署 | 无 A 的后台连接 / 状态污染 B；远端出口具备同样限制 |

应用侧测试和出口测试应能够独立证明各自边界，避免防火墙把应用拦截缺失掩盖成“代码已修复”。随后再通过真实抓取函数与 HTTP/MCP 入口验证组合行为、错误传播和资源回收。

保留证据：实际浏览器 / Playwright 版本、运行模式、本地或远程位置、出口配置版本、目标请求计数、关键拦截原因及资源恢复结果；不得记录真实 Cookie、令牌或带秘密的 URL。

**11. 实施与关闭条件**

1. 建立统一策略和受控 context 工厂，迁移 Cookie 采集与 HTML 抓取，处理页面路由优先级及默认 context 回退。
2. 补弹窗、WebSocket、worker、逐跳及运行中故障处置，完成 T01—T06、T08—T10、T12—T13 的应用侧验证。
3. 部署强制出口，完成 T07、T11、T14 和完整入口回归；按本地 / 远程浏览器模式记录实际支持范围。
4. 所有必需项通过后更新审计结论。若仅完成应用侧修复，记录已阻断的 C03 变体和仍依赖的出口条件；C04 Node HTTP 分支单独跟踪。

开发实现、出口配置和验收证据是三个独立交付物。上线必须同时满足适用部署模式的防护与验证条件；不能以最终 URL 检查、普通代理配置或“发生异常后关闭页面”替代本方案的连接前约束。
