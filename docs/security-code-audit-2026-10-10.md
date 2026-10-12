# open-websearch 代码安全复核报告

审计日期：2026-10-10（Asia/Shanghai）  
项目目录：`D:/fosun/open-webSearchEE`  
Git HEAD：`7b348d9349de72404fea5c9eea4a7f542622984c`  
审计对象：当前工作区，包括审计开始前已有的未提交修改与新增源码，不限于 HEAD。

## 结论

识别出 **9 项应用代码安全问题：6 项高风险、2 项中风险、1 项低风险，没有确认的严重（Critical）问题**。评级以各项列明的部署条件为前提，其中跨域凭据转发、配置凭据泄露需要实际配置含有效凭据。Host / Origin 检查缺失已验证，但没有执行真实浏览器 DNS 重绑定攻击；旧进程记录问题通过原函数与模拟系统操作验证，没有杀死真实进程。

应优先处理未认证 HTTP 入口、浏览器出网边界与代理实际目的地址校验。它们可以叠加：可访问 HTTP 端口的调用者能启动抓取，而恶意网页或解析差异能够绕过部分网络限制。公网是否可达、代理和浏览器能访问哪些网络，需要结合部署判断。

本次重新查询 npm 公告库，全量及生产依赖审计均为 **0 告警**；当前安装版本与锁文件的 185 个依赖条目无版本漂移。TypeScript 构建通过。选取的 24 项现有回归测试 **22 项通过、2 项失败、0 项跳过**；失败源于测试仍期望旧的会话预算，补充验证确认当前 16 会话、5 分钟空闲回收预算正常生效。依赖无告警和回归通过不代表下列逻辑漏洞不存在。

**仅新增本报告与审计证据，未修复或改动业务源码、依赖和部署配置。** 保留审计前后源码摘要对比、Git 状态及基础设施文件摘要。

| 编号 | 风险 | 问题 | 主要条件 / 验证范围 |
| --- | --- | --- | --- |
| C01 | 高 | MCP HTTP 无认证且默认监听所有接口 | 攻击者能连接端口；无认证初始化和工具发现已复现 |
| C02 | 高，有条件 | MCP / daemon 缺少 Host、Origin 校验 | 非可信 Host、Origin 被接受；完整浏览器重绑定未执行 |
| C03 | 高，有条件 | 浏览器守卫遗漏弹窗首请求与 WebSocket | 启用浏览器抓取且浏览器网络策略允许；真实浏览器访问了自建私网测试服务 |
| C04 | 高，有条件 | DNS 预检没有约束代理 / 浏览器实际连接地址 | 使用代理或浏览器且两侧解析不一致；完整网页抓取函数返回了测试私网内容 |
| C05 | 高，有条件 | 跨源重定向保留 Cookie / Authorization | 源请求带有效敏感头且重定向可被控制；虚构凭据转发已复现 |
| C06 | 高，有条件 | 配置凭据进入日志和未认证错误响应 | 代理 / 浏览器 URL 带有效凭据；虚构令牌从 HTTP 503 响应泄露已复现 |
| C07 | 中 | 浏览器页面求值没有整体期限，可耗尽抓取槽位 | 恶意网页脚本；真实浏览器超过导航预算仍未结束 |
| C08 | 中 | 浏览器清理在身份校验失败后仍终止记录中的 PID | 失效记录与 PID 复用，或本地记录可被修改；原函数模拟系统操作验证 |
| C09 | 低，凭据有效性未知 | 源码硬编码 Cookie 和 CSRF 值 | 静态发现三处；未验证登录状态或有效性 |

## 范围、方法与证据

盘点全部 103 个 TypeScript 文件，其中 43 个位于测试目录，另 60 个为其他源码（包括声明及辅助入口）；结合 AST 调用点索引、文本检查和手工调用链审阅，检查以下边界：

| 范围 | 检查重点与结论 |
| --- | --- |
| CLI、stdio、HTTP MCP、SSE、本地 daemon | 参数进入核心服务的路径、会话创建、认证、Host / Origin、CORS、错误输出；见 C01、C02、C06 |
| 搜索引擎、通用和专用网页抓取 | URL 解析、逐跳重定向、DNS 与实际连接、代理、敏感头、响应大小；见 C04、C05 |
| 浏览器、页面池、Cookie、远程浏览器 | CDP 与页面拦截覆盖、WebSocket、弹窗、Cookie 传递、求值期限、进程生命周期；见 C03、C06—C08 |
| 资源限制 | 搜索去重、输入上限、并发、会话回收、响应上限；当前预算实测生效，但浏览器操作期限仍有 C07 |
| 命令、文件、内容解析 | 子进程参数、路径和临时记录、JSDOM / HTML 返回；确认 C08，未发现可由请求参数直接触发的任意命令执行或任意文件下载入口 |
| 依赖与交付配置 | npm 全量 / 生产公告、安装漂移、Docker、Compose、GitHub Actions；依赖告警 0，部署暴露与加固事项见后文 |
| 凭据 | 配置输出、源码敏感常量；见 C06、C09，证据不包含硬编码凭据原文 |

执行环境为 Windows，构建及测试使用 Node.js **v22.23.3**、npm **10.9.8**；真实隔离浏览器为 Edge / Chromium **154.0.4258.62**。系统默认 Node 为 v22.23.2，本次没有修改全局安装。原始记录位于 [证据目录说明](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/README.md)，文件摘要见 [manifest.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/manifest.json)。

动态验证只访问审计自建的 loopback 服务，使用临时隔离浏览器和虚构凭据。所谓“公网源站”由 Node 测试 DNS hook、Chromium host 映射和受控 CONNECT 代理模拟；没有扫描企业内网、云元数据、真实用户浏览器或线上服务。解析差异的复现证明应用边界不足，不等于已经在生产 DNS 基础设施实施了重绑定攻击。

未运行 Semgrep、CodeQL、Gitleaks、容器镜像漏洞扫描或完整线上集成测试；未验证 Linux 的真实跨用户利用、已有 Cookie 的有效性、远程部署的认证代理和网络隔离，也未对完整 Git 历史执行秘密扫描。本报告不能保证发现所有漏洞。

## C01：未认证的 MCP HTTP 默认对所有接口监听

**位置：** [默认启用 HTTP](D:/fosun/open-webSearchEE/src/config.ts:74)、[默认监听地址](D:/fosun/open-webSearchEE/src/adapters/http/serverOptions.ts:30)、[MCP 初始化](D:/fosun/open-webSearchEE/src/index.ts:145)、[SSE 入口](D:/fosun/open-webSearchEE/src/index.ts:265)、[消息入口](D:/fosun/open-webSearchEE/src/index.ts:321)、[Compose 发布端口](D:/fosun/open-webSearchEE/docker-compose.yml:10)。对应 CWE-306。

未设置 MODE 时开启 HTTP；未指定本地监听选项时绑定 `0.0.0.0:3000`。`/mcp`、`/sse`、`/messages` 没有身份认证和调用者权限检查。客户端能够自行初始化并取得 session ID，随机会话 ID 不能替代认证。Compose 以 `3000:3000` 发布端口并启用通配 CORS。

**验证：** 隔离 MCP 以 loopback 启动，未携带 Authorization，初始化返回 200、分配会话，随后 `tools/list` 返回 200 和工具列表。默认地址通过项目实际解析函数确认为 `0.0.0.0`。未向真实上游调用工具；工具调用缺少授权的结论同时来自入口至注册处理函数的调用链审阅。见 [adapter-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/adapter-probes.json)。

**影响 / 条件：** 端口可达的调用者可使用服务的搜索、抓取与浏览器资源，能够与 SSRF 和资源耗尽问题叠加。是否互联网可达取决于实际防火墙和反向代理，未检查线上部署。

**修复与验收：** 默认监听 loopback，远程监听显式开启；所有 HTTP / SSE 入口统一认证、授权和调用配额。若由反向代理认证，应隔离后端直连。验收时无凭据初始化、工具调用和 SSE 均应被拒绝，直接后端访问不能绕过代理认证；获授权客户端正常工作。限制 CORS 来源，但不要把 CORS 当作身份认证。

## C02：本地与远程 HTTP 入口缺少 Host / Origin 校验

**位置：** [MCP transport 配置](D:/fosun/open-webSearchEE/src/index.ts:172)、[daemon 中间件](D:/fosun/open-webSearchEE/src/adapters/http/localDaemon.ts:175)、[daemon 业务入口](D:/fosun/open-webSearchEE/src/adapters/http/localDaemon.ts:212)。对应 CWE-346。

MCP 的 DNS rebinding protection、allowedHosts 仍只存在于注释。daemon 虽默认绑定 loopback，但也没有 Host / Origin 白名单或访问令牌。关闭 CORS 不会对所有传入请求执行来源校验，也不能防止相同攻击者域名解析切换后的同源访问。

**验证：** 在 `Host: attacker.invalid`、`Origin: http://attacker.invalid`、跨站标记的请求下，daemon `/fetch-juejin` 返回 200 并调用了测试替身；MCP 的初始化与工具发现同样成功。见 [adapter-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/adapter-probes.json)。

**影响 / 条件：** 在浏览器及本地网络策略允许的环境，恶意站点可能利用解析切换访问本地服务。这次确认检查缺失，没有运行完整浏览器重绑定流程；浏览器本地网络权限、混合内容限制和部署认证会影响可利用性。该问题也与 C01 不同：即使仅监听 loopback，仍需要来源与访问身份检查。

**修复与验收：** 启用并配置 MCP 的 Host / Origin 保护，daemon 使用严格且可配置的 Host 和 Origin 白名单与访问令牌，覆盖所有路由；仅信任明确指定的代理转发信息。非法 Host / Origin 应在业务执行前返回 403，可信本地客户端和受控反向代理路径应继续可用。[MCP HTTP 安全要求](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)要求验证 Origin，并建议本地绑定及适当认证。

## C03：浏览器守卫遗漏弹窗首请求和 WebSocket

**位置：** [installNavigationGuard](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:187)、[仅绑定当前页面的 CDP Fetch 与 route](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:200)、[context 创建](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:239)、[HTML 抓取入口](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:357)。对应 CWE-918。

当前守卫同时使用当前 page 的 CDP Fetch 和 page.route，已能拦截本次测试的主导航与图片重定向；但它没有覆盖新弹窗的首请求，也没有拦截 WebSocket 握手。context 创建时未明确阻断 Service Worker；后者本次未动态验证，属于覆盖风险而非额外已复现漏洞。

**真实浏览器结果：**

| 场景 | 当前结果 |
| --- | --- |
| 主导航重定向到 `127.0.0.1` | 拦截成功，私网测试服务没有收到请求 |
| 图片重定向到 `127.0.0.1` | 拦截成功，私网测试服务没有收到请求 |
| 页面脚本打开私网弹窗 | 测试服务收到 `/popup-target`，产生第二个页面 |
| 页面脚本连接私网 WebSocket | 测试服务收到握手；页面读到了测试服务发送的标记 |

见 [browser-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/browser-probes.json)。使用的是项目实际守卫与隔离 Chromium。弹窗变体确认至少能够发出私网请求；WebSocket 变体还确认脚本可以读取私网服务返回的数据并写入页面。C03 的这两个变体直接测试了守卫，没有另行通过 MCP 做完整外传演示。

**影响 / 条件：** 需启用浏览器抓取、加载恶意网页且浏览器网络策略允许相关请求。最终主页面 URL 不变，因此抓取后的 URL 校验无法发现这些旁路。网络请求来自浏览器部署位置，可能与 Node 服务不在同一机器。[Playwright page.route 文档](https://playwright.dev/docs/api/class-page#page-route)说明其不覆盖弹窗首请求和被 Service Worker 接管的请求；WebSocket 需要独立处理。

**修复与验收：** 将实际连接的私网限制落实到浏览器出口代理 / 网络层，同时在 context 级管理所有页面；默认拒绝弹窗和不需要的 WebSocket、Service Worker。启用需要的通道时采用同样的目的地址策略。验收包括弹窗首请求、WebSocket、worker 和多级重定向；禁止目的地址的测试服务应收到零请求，不能只检查最终 URL 或返回内容。

## C04：DNS 预检与代理 / 浏览器实际连接地址脱节

**位置：** [异步 DNS 预检](D:/fosun/open-webSearchEE/src/utils/urlSafety.ts:101)、[代理替换过滤 agent](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:207)、[逐跳检查后传入原域名](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:264)、[浏览器请求预检](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:174)。对应 CWE-918。

`assertPublicHttpUrlResolved` 验证 Node 解析结果，但不返回或绑定经验证的连接 IP。代理启用后使用 HttpsProxyAgent，由代理解析 / 连接原域名；浏览器也使用自己的解析器和网络栈。反复预检与最终 URL 检查不能保证实际连接仍为当时验证的地址。

**验证：** 受控 CONNECT 代理中，Node 预检返回模拟公网地址，代理连接审计自建的 loopback 服务，真实 `requestWithSafeRedirects` 返回了测试私网标记。浏览器中使用同样的解析差异模型，除守卫层验证外，还通过实际 `fetchWebContent(url, maxChars, { renderMode: 'browser' })` 路径拿到了测试私网内容，返回方式为 `browser-html`。见 [network-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/network-probes.json)、[browser-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/browser-probes.json)。

**影响 / 条件：** 需使用代理或浏览器，并存在不同解析视图、可控解析切换或不可信代理。直接 HTTP 的过滤 agent 在本次测试中有效，因此本结论不应扩大为“所有直连请求均可绕过”。夹具模拟解析分歧，没有攻击真实 DNS。

**修复与验收：** 在负责实际连接的一侧验证并约束目标 IP，包括代理端和远程浏览器端；可采用经过验证的地址连接、保留正确 Host / TLS SNI，或统一受控出口代理与网络 ACL。每次跳转和重新建连都应用同一策略。验收应让预检与真实解析故意返回不同结果，确保私网服务零命中；仅增加一次预检不能解决问题。[OWASP SSRF 防护建议](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)讨论了 DNS 检查与网络层控制。

## C05：跨源手动重定向转发敏感头

**位置：** [保留原 options 的逐跳请求](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:266)、[切换重定向 URL](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:285)、[网页抓取 Cookie 头](D:/fosun/open-webSearchEE/src/engines/web/fetchWebContent.ts:245)、[CSDN Cookie](D:/fosun/open-webSearchEE/src/engines/csdn/fetchCsdnArticle.ts:25)。对应 CWE-201。

手动跟随重定向时保留原 `options.headers`，没有在 origin 变化或 HTTPS 降级时移除 Cookie、Authorization 等敏感头。传给 Axios 的每一跳都是新的独立请求，不能依赖 Axios 自动重定向逻辑来代为清理。

**验证：** 模拟源站重定向到另一 hostname，目的测试服务实际收到 `Cookie: audit_session=DUMMY_NO_REAL_SECRET` 和 `Authorization: Bearer AUDIT_DUMMY`。见 [network-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/network-probes.json)。这里只使用虚构凭据，没有发送真实 Cookie。通用网页抓取在已有浏览器 Cookie 的部分重试路径会构造 Cookie；专用 CSDN 抓取也存在 Cookie 来源。

**影响 / 条件：** 只有源请求携带有效敏感头，且源站重定向被攻击者控制或被诱导时，才构成有效会话 / 凭据泄露。不能据此断言项目已经泄露真实用户会话。

**修复与验收：** 比较规范化后的 scheme、hostname、有效端口，跨 origin 清除敏感头，并禁止凭据随 HTTPS → HTTP 降级。Cookie 应按每跳目标重新通过浏览器 Cookie 策略获取，不沿用拼好的源 Cookie 字符串。验收覆盖同源保留、跨域 / 换端口 / 降级剥离，并确认正常无凭据重定向可用。

## C06：配置凭据写入日志，并经未认证错误响应泄露

**位置：** [代理配置日志](D:/fosun/open-webSearchEE/src/config.ts:175)、[远程浏览器 URL 日志](D:/fosun/open-webSearchEE/src/config.ts:193)、[WS 连接错误](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:2356)、[CDP 连接错误](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:2372)、[daemon 返回原错误文本](D:/fosun/open-webSearchEE/src/adapters/http/localDaemon.ts:302)。对应 CWE-532、CWE-209。

启动日志直接输出代理和远程浏览器完整 URL；连接失败时包装错误再次嵌入完整 endpoint。daemon 将原始 error.message 返回给客户端，MCP 错误处理也保留原错误文本，因此查询参数中的访问令牌或 URL userinfo 可能跨越配置保密边界。关闭启动日志只能处理其中一条路径。

**验证：** 使用虚构代理用户名 / 密码和浏览器 query token，确认启动日志含密码和令牌。配置一个无法连接的自建 loopback WS endpoint 后，未认证 `/fetch-web` 请求返回 503，错误码 `browser_unavailable`，响应含配置的虚构 token。浏览器连接失败发生在网页导航前，没有访问传入的公网 URL。证据已脱敏，见 [information-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/information-probes.json)。

**影响 / 条件：** 需相关 URL 含有效凭据。日志读取者可能获得代理 / 浏览器访问权限；HTTP 调用者在连接故障时也可能获得浏览器令牌，不需要控制该 endpoint。无凭据配置下此项的影响会降低。

**修复与验收：** 统一 URL 脱敏，去掉 userinfo，并遮蔽 query / fragment 中的秘密；对外仅返回稳定错误码与简短说明，内部诊断同样禁止秘密原文。验收对启动日志、WS/CDP 失败、daemon 与 MCP 响应使用假密码 / 假 token，确保其原文均不出现。若曾配置有效凭据并对外暴露该路径，应轮换相关凭据。

## C07：恶意网页可让页面求值超出预算并占据抓取容量

**位置：** [导航超时](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:422)、[无整体期限的页面求值](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:437)、[后续内容读取](D:/fosun/open-webSearchEE/src/utils/browserCookies.ts:446)、[仅在 operation 结束后释放抓取槽位](D:/fosun/open-webSearchEE/src/core/fetch/fetchServices.ts:14)。对应 CWE-400。

导航超时只约束 goto 等局部步骤，没有覆盖整个浏览器抓取。页面大小估计执行 `new Blob([document.documentElement.outerHTML]).size`，运行在可被恶意页面修改的脚本环境；页面可以替换 Blob，使该 evaluate 永不返回。随后 `page.content` 和其他求值也没有统一截止时间。页面释放和抓取槽位回收依赖这些 await 结束。

**验证：** 自建页面替换 Blob，并以本地请求标记确认进入大小估计后开始循环。实际 `fetchWebContent` 的导航预算设为 1,000 ms，观察 4,001 ms 后操作仍未结束；终止本次自建的隔离浏览器后调用才以错误结束。见 [browser-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/browser-probes.json)。本次只运行一个有时限的恶意页面，没有做并发压力攻击。

**影响 / 条件：** 攻击者能让服务抓取恶意网页时，可占据浏览器 CPU / 页面与抓取槽位。全局抓取并发预算为 4，多个不结束的请求可能使其他抓取返回资源限制错误；此叠加结论来自槽位代码，未在实际服务耗尽四个槽位。

**修复与验收：** 为整个浏览器操作设置独立绝对期限，覆盖导航、Cookie、求值、内容读取和清理；到期主动关闭 / 隔离页面或替换故障 worker，再可靠归还容量。单独 Promise.race 后继续留下后台页面不足以回收资源。验收使用会循环的 getter / 构造器以及迟滞页面，确保在预算内结束、容量可恢复、后续正常请求成功。

## C08：失效或不可信浏览器记录触发未验证 PID 的终止

**位置：** [metadata 规范化](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:960)、[验证不到浏览器仍终止旧 PID](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:1411)、[Windows taskkill](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:1704)、[非 Windows kill](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:1711)。对应 CWE-20、CWE-807。

浏览器记录的 browserPid 只检查整数，没有要求为正数。更直接的问题是：`resolveLocalBrowserCandidatePid` 无法根据 tempDir / debugPort 验证进程身份时，清理分支仍将记录中的 PID 传入 createForceKill。进程崩溃后 PID 可能已被其他程序复用；“找不到符合身份的浏览器”不能作为终止该 PID 的依据。共享临时目录记录的所有权和路径也缺少完整约束，若本地用户能篡改这些记录会放大风险。

**验证：** 从当前源码抽取 normalize、cleanup、force-kill 三个原函数，在 VM 中替换所有进程和文件操作。负数 `browserPid=-1` 被接受，在模拟 Linux 中会调用 `process.kill(1)` 和 `process.kill(-1)`；模拟 Windows 中，无法验证为浏览器的旧 PID 424242 仍产生 `taskkill /F /T /PID 424242`。见 [metadata-probe.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/metadata-probe.json)。**实际发送信号 0 次，删除文件 0 个**；未执行 Linux 跨用户攻击或确认部署目录可被其他用户写入。

**影响 / 条件：** 可能误终止同权限的非浏览器进程并造成服务中断。PID 复用不要求恶意本地用户；篡改 / 负 PID 变体则需要本地记录写入条件。操作仍受运行账号权限约束，没有证明权限提升或任意目录递归删除。

**修复与验收：** 读取和最终操作均校验正 PID；只终止能验证进程身份及归属、且确由本服务管理的进程。无法确认身份时只处理自身可信记录，不对记录 PID 发信号。使用私有且权限受控的 metadata 目录，验证所有者、规范化路径及符号链接；以进程句柄 / 创建时间降低 PID 复用竞态。验收覆盖负数、0、过期 / 复用 PID、不匹配 tempDir / debugPort 和伪造记录，未验证进程必须收到零信号。

## C09：源码保留硬编码 Cookie 与 CSRF 值

**位置：** [CSDN 搜索 Cookie](D:/fosun/open-webSearchEE/src/engines/csdn/csdn.ts:19)、[LinuxDo CSRF](D:/fosun/open-webSearchEE/src/engines/linuxdo/fetchLinuxDoArticle.ts:31)、[LinuxDo Cookie](D:/fosun/open-webSearchEE/src/engines/linuxdo/fetchLinuxDoArticle.ts:33)。对应 CWE-798（是否构成有效认证凭据待确认）。

静态识别到 3 个敏感头字面量，长度分别为 651、86、678 字符，包含 Cookie 和 CSRF 相关值。[静态索引](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/static-inventory.json)只记录位置、名称和长度，没有复制原文。

**影响 / 条件：** 这些值可能只是过期会话或反爬状态；没有验证其有效性，也不能断言已泄露有效登录账户。保留真实会话样本仍会增加后续误用与源码泄露风险。

**修复与验收：** 删除硬编码值，需要认证时使用按运行环境注入的最小权限凭据；若历史值曾有效，应撤销并评估清理 Git 历史。静态验收应确认生产源码不再包含真实会话头，必要的测试样本使用明确虚构值。

## 已生效的防护与测试差异

本次按当前工作区重新验证，没有把 2026-10-09 的问题原样计入：

| 旧报告项 | 当前结论 |
| --- | --- |
| A01 / A02：认证与来源校验 | C01 / C02 仍存在 |
| A03：主导航、资源重定向及弹窗 | 主导航与图片重定向已拦截；弹窗仍遗漏，新增验证 WebSocket，见 C03 |
| A04：代理解析差异与掘金重定向 | 解析与连接脱节仍存在，见 C04；掘金现在逐跳调用安全 helper，指向私网的 DNS 重定向已拒绝 |
| A05：跨域敏感头 | 仍存在，见 C05 |
| A06：搜索放大与无上限资源 | 当前去重、输入、并发、页面池、Cookie cache 和会话预算已有防护；没有继续将旧问题作为当前漏洞 |
| A07：HTTP 请求缺少统一预算 | 当前 helper 15 秒整体期限与 2 MiB 限制已生效；浏览器求值的剩余缺口单列 C07 |
| A08 / A09：凭据输出及硬编码 | 分别见 C06 / C09；新增验证未认证 HTTP 错误响应路径 |

补充隔离验证确认：HTTP 2 MiB + 1 字节响应被拒绝；30 ms 测试期限约 39 ms 触发；搜索引擎去重后 limit=1 只执行一次；超长查询 / 过多引擎输入被拒绝；搜索、抓取并发 4 的第五项被拒绝；第 17 个 MCP 会话返回 429，DELETE 后可重新创建；当前 5 分钟 idle 边界能回收全部测试会话。详见 [resource-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/resource-probes.json)及 [adapter-probes.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/adapter-probes.json)。

24 项回归详见 [regression-results.json](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/regression-results.json)，失败项目为：

- [test-resource-limits.ts:133](D:/fosun/open-webSearchEE/src/test/test-resource-limits.ts:133)仍期望默认 4 会话、3 分钟 idle；实际默认 16 会话、5 分钟，首先在“第五个必须拒绝”断言失败，因此文件后续检查未完整执行。
- [test-mcp-resource-limits.ts:68](D:/fosun/open-webSearchEE/src/test/test-mcp-resource-limits.ts:68)仍断言成功会话数为 4，实际为 16；在此断言失败，不能把该文件的后续断言算作通过。

这两项需要与产品期望预算对齐。补充脚本验证了当前实现的关键边界，但不等于这两个现有测试已经通过，也不等于执行了全部 43 个测试文件。首次受沙箱网络限制的尝试单独保留，最终统计以允许 loopback 验证后的结果为准。

## 依赖与交付加固事项

重新执行 `npm audit --package-lock-only --json` 和生产依赖变体，两份结果所有风险级别均为 0，见 [全量审计](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/npm-audit-all.json)、[生产审计](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10/npm-audit-production.json)。`npm ls --all` 正常，安装与锁文件版本比对无漂移。此结果只覆盖 npm 公告与依赖树，不覆盖操作系统、Chromium、容器镜像或未公开漏洞，也不沿用昨天的依赖告警数字。

以下是部署 / 防御纵深建议，**不额外计入上述 9 项已列问题**：

- [Linux 浏览器启动](D:/fosun/open-webSearchEE/src/utils/playwrightClient.ts:2028)显式使用 `--no-sandbox`、`--disable-setuid-sandbox`，并削弱部分站点隔离保护。抓取不可信页面时应使用专用低权限 worker、可用的浏览器 sandbox、受限网络与资源。未证明浏览器 RCE，不能将这些标志直接判为已可远程执行代码。
- [.dockerignore](D:/fosun/open-webSearchEE/.dockerignore:1)未排除 `.env`、私钥等敏感文件，而 Docker build 有复制工作区的步骤。建议显式排除秘密、使用构建 secret。当前多阶段最终镜像只复制指定产物，不能据此断言 `.env` 已进入最终镜像；风险首先是构建上下文及缓存。
- [Compose](D:/fosun/open-webSearchEE/docker-compose.yml:6)使用可变 `latest` 镜像标签，工作流 Actions 使用版本标签且未显式收紧 token 权限；建议固定经过审查的镜像摘要 / Action commit、设置最小权限并保留来源证明。本次没有构建或扫描最终镜像。
- Dockerfile 已使用非 root 运行与生产依赖裁剪，不再沿用旧 Docker 安装降级路径的结论。工作流的发布标签输入有格式验证，未确认请求参数可直接拼接成命令执行。解析出的 HTML 是返回数据；未发现项目将其直接作为不可信 HTML 注入自身页面，不能仅凭返回 readableHtml 判定项目 XSS。

## 建议处理顺序

1. 收敛 HTTP 暴露范围，补认证及 Host / Origin 校验（C01、C02），阻断未授权调用入口。
2. 在浏览器 / 代理实际出口实施目的地址约束，同时补弹窗和 WebSocket 边界（C03、C04）。
3. 修复敏感头重定向和所有日志 / 错误脱敏（C05、C06），必要时轮换历史有效凭据。
4. 为浏览器任务加整体期限与可靠回收，修正失效 PID 处理，移除硬编码凭据（C07—C09），将本报告验收场景加入有意义的安全回归。

完成修复后应重新验证对应隔离用例及现有回归，尤其检查私网测试服务零命中、秘密原文零输出、超时后容量恢复、未验证 PID 零信号。当前报告记录的是审计时状态，不是修复完成证明。
