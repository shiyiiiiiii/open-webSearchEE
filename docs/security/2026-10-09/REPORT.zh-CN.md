# 项目依赖已知 CVE 检查报告

检查日期：2026-10-09，Asia/Shanghai。项目：open-websearch@2.2.0。工作区 Git 提交：`7b348d9349de72404fea5c9eea4a7f542622984c`。

**结论：当前工作区存在需要升级的已知漏洞依赖；Compose 发布镜像还包含较旧依赖和已停止支持的 Node 20。版本命中已经确认，不能将所有命中直接等同于当前业务可被远程利用。**

## 1. 检查覆盖与统计口径

- 锁文件 187 个条目、180 个不同包版本：生产 171，仅开发 16。13 个直接生产依赖、6 个直接开发依赖均纳入检查。
- 本地安装 186 个依赖条目，与锁文件无版本漂移、无额外安装包。唯一未安装项是 macOS 专用可选开发依赖 fsevents@2.3.2；它仍按锁定版本完成查询。
- 补查 node_modules 内附带的 cnoke@4.0.3、private benchmark@1.0.0 元数据；OSV 共查询 182 个包版本。这两项不是依赖树主统计中的新增生产依赖；不能仅凭附带 package.json 认定其内容就是同名 npm 发布物。
- 数据源：npm 官方 registry 审计（全量及生产树）、OSV 精确包版本查询、Trivy 0.75.0。Trivy 数据库更新时间为 2026-10-09T01:16:59.530806077Z（UTC）；交叉匹配 GHSA/CVE 别名后，工作区命中集合一致。
- 补查本地 Node 内置组件、Dockerfile 当前基础镜像、Compose latest 的 amd64/arm64 具体 digest，以及工作流引用的 5 个 GitHub Actions。
- 本次没有执行 npm audit fix、npm install、更新 manifest/lock、构建或部署容器。两项既有测试通过 TypeScript 编译后执行；生成的 build 文件属于忽略目录。

| 统计对象 | 结果 |
| --- | --- |
| npm 受影响包（包括上层传播） | 10：7 高危、3 中危、0 严重 |
| 自身具有漏洞公告的包版本 | 9，均在生产依赖树中 |
| 去重漏洞公告 | 55：8 高危、42 中危、5 低危 |
| 去重 CVE | 54；另有 1 条仅有 GHSA 编号 |
| 开发专用依赖版本命中 | 0 |
| 全量 / omit=dev 审计 | 受影响包及严重性统计一致 |

npm 的“10 个 vulnerabilities”是受影响包计数，不是 10 个 CVE。express-rate-limit 是由 ip-address 传播的上层命中，不重复产生 CVE。未命中表示本次所用数据库没有相关记录。

## 2. 受影响依赖与修复版本

| 依赖 | 锁定版本 | 包最高严重性 | 类型 | 独立公告数 | 消除本次命中的版本 |
| --- | --- | --- | --- | --- | --- |
| @hono/node-server | 1.19.11 | 中危 | 传递生产 | 2 | ≥1.19.15 |
| @modelcontextprotocol/sdk | 1.27.1 | 高危 | 直接生产 | 1 | ≥1.31.0 |
| express-rate-limit | 8.3.1 | 中危 | 传递生产 | 0 | 建议 8.7.1，并解析 ip-address ≥10.7.1 |
| hono | 4.12.7 | 高危 | 传递生产 | 31 | ≥4.13.7 |
| ip-address | 10.1.0 | 高危 | 传递生产 | 5 | ≥10.7.1 |
| path-to-regexp | 8.3.0 | 高危 | 传递生产 | 2 | ≥8.4.0 |
| qs | 6.15.3 | 中危 | 传递生产 | 2 | ≥6.16.0 |
| request-filtering-agent | 3.2.0 | 高危 | 直接生产 | 1 | ≥3.2.1 |
| undici | 6.24.0 | 高危 | 传递生产 | 9 | ≥6.28.1 |
| ws | 8.18.2 | 高危 | 传递生产 | 2 | ≥8.21.0 |

这些修复版本已确认在 npm registry 发布，且在 OSV 中重新查询没有命中。上层包升级后必须检查实际生成的整个锁文件；父包采用宽松范围时，旧传递依赖可能继续被保留。推荐版本的无命中查询不等于已完成项目兼容性验证。

## 3. 实际触发条件核查

- **@modelcontextprotocol/sdk**：公告针对 HTTP OAuth 客户端。本项目导入服务端 McpServer 和服务端 transport，未发现 SDK 客户端 OAuth 调用；官方公告明确服务端不受该漏洞影响。仍建议升级以消除供应链版本命中。
- **request-filtering-agent**：实际用于出站 HTTP/HTTPS 请求。当前 URL 校验在请求前拒绝私网字面量，并逐跳校验重定向；两项既有防护测试通过。该防护降低公告所述私网字面量触发路径的暴露，但不改变库版本命中，建议优先升级。
- **@hono/node-server**：SDK Streamable HTTP transport 使用 getRequestListener；命中公告均要求 serveStatic 静态文件服务。当前代码未使用 serveStatic，未发现公告对应调用路径。
- **hono**：经 SDK 引入。命中项涉及 Hono 的静态文件、JSX、JWT、CORS、缓存、SSG、代理、语言等 API；当前 HTTP 入口使用 Express，未发现这些 Hono API 的业务调用。
- **ip-address**：经 SDK → express-rate-limit 引入。项目的 URL/IP 校验实际使用另一库 ipaddr.js，不应混淆两者；未发现项目使用 ip-address 的 HTML 输出/子网判断或启用 SDK OAuth 限流路由。
- **express-rate-limit**：npm 因其固定依赖 ip-address@10.1.0 标记该上层包；该包没有独立公告，不能再计为新的 CVE。升级上层包并确认其 ip-address 实际解析版本。
- **path-to-regexp**：经 Express → router 引入。公告要求路由含多个通配符或连续可选组；当前业务路由为固定路径，未发现这类路由模式。
- **qs**：Express 与 body-parser 的传递依赖。当前入口仅启用 express.json()，Express 默认 query parser 为 simple；未发现 extended 查询解析或 urlencoded 中间件，对应触发条件未证实。
- **undici**：锁文件中的 undici 经 Cheerio 引入；源码使用 cheerio.load，未发现 fromURL 或 Undici WebSocket/重试拦截器调用。Node 内置的 Undici 是另一个版本，见运行时补查。
- **ws**：经 jsdom 引入。项目使用 new JSDOM(html)，未启用 runScripts 或外部资源加载，也未发现直接 ws 调用；当前网页解析路径未证实能触发这些 WebSocket 漏洞。

源码证据：[MCP 服务端导入](D:/fosun/open-webSearchEE/src/index.ts:2)、[Express HTTP 入口及固定路由](D:/fosun/open-webSearchEE/src/index.ts:96)、[本地 HTTP 入口](D:/fosun/open-webSearchEE/src/adapters/http/localDaemon.ts:168)、[逐跳安全请求](D:/fosun/open-webSearchEE/src/utils/httpRequest.ts:201)、[URL 校验](D:/fosun/open-webSearchEE/src/utils/urlSafety.ts:65)、[JSDOM 使用方式](D:/fosun/open-webSearchEE/src/engines/web/fetchWebContent.ts:124)。

MCP 的服务端适用性依据来自[官方安全公告](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h)。request-filtering-agent 的异常终止条件见[维护者公告](https://github.com/azu/request-filtering-agent/security/advisories/GHSA-r3r9-wp5j-pq5g)。路由模式要求见[path-to-regexp 公告](https://github.com/pillarjs/path-to-regexp/security/advisories/GHSA-j3q9-mxjg-w52f)。上述“未发现调用路径”是对当前源码的静态判断，不是形式化可达性证明。

既有防护验证：`npm.cmd run test:url-safety`、`npm.cmd run test:redirect-safety` 均退出 0；`npm.cmd ls --all --json` 退出 0，无依赖树问题。测试日志已保存。没有执行会耗尽资源或终止项目服务的漏洞 PoC。

## 4. 本地 Node 运行时补查

检测到 Node v22.23.2，内置 Undici 6.28.0、OpenSSL 3.5.7、c-ares 1.34.6。这与 package-lock 中的 npm Undici 6.24.0 是不同安装实体。

- Node 安全工作组 core 索引检查了 194 条记录；同时匹配 vulnerable 范围、排除 patched 范围及不适用平台后，没有未修复的 core 索引命中。该索引不覆盖全部内置第三方库公告。
- **内置 Undici 6.28.0** 另外命中 CVE-2026-19534（高危）、CVE-2026-85024（中危）、CVE-2026-18540（低危）。修复线为 6.28.1；两条与 npm Undici 清单重叠，一条是新增 CVE，因此不直接加进“54 个 npm CVE”。源码没有直接使用 globalThis.WebSocket 或 retry interceptor，实际触发路径未证实。[Undici 维护者公告](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v)。
- **c-ares 1.34.6** 命中上游 CVE-2026-33630、CVE-2026-69184、CVE-2026-69186，修复版本 1.34.7。对比官方 Node v22.23.2 的 ares_process.c 与 c-ares 源码，SHA256 与未修复的 v1.34.6 完全相同，与 v1.34.7 不同；实际本地二进制的构建来源尚未核实。本项目显式 DNS 校验使用 dns.lookup（系统解析器），不是直接调用公告涉及的 c-ares API。[c-ares 官方清单](https://c-ares.org/vulns.html)。
- **OpenSSL 3.5.7** 与上游公告的 23 条 CVE 版本范围匹配，明细单列为运行时候选；包含 DTLS、QUIC、CMP 等本项目未直接使用的接口，不能全部判为可利用。覆盖这些上游版本范围需要 OpenSSL 3.5.9 或相应回补补丁。[OpenSSL 公告](https://openssl-library.org/news/secadv/20260929.txt)。

官方 [Node 22.23.3 发布说明](https://nodejs.org/en/blog/release/v22.23.3)说明其内置 Undici 升至 6.28.1、c-ares 升至 1.34.8、OpenSSL 升至 3.5.8。因此升级到 22.23.3 可处理前两组版本命中，但不能宣称已经覆盖 9 月底要求 OpenSSL 3.5.9 的公告。应选择受支持的 Node 补丁版本，并验证其内置组件/回补状态。

## 5. Docker 与发布镜像

扫描通过远程 registry 拉取完成，无需 Docker daemon，没有运行镜像。Compose 当前引用 `ghcr.io/aas-ee/open-web-search:latest`；本次将其解析成固定平台 digest 后扫描。

| 对象 | 平台 | 包 × 公告命中数 | 去重公告 ID | 严重 / 高危 / 中危 / 低危 |
| --- | --- | --- | --- | --- |
| Compose latest | linux/amd64 | 154 | 124 | 2 / 42 / 70 / 40 |
| Compose latest | linux/arm64 | 154 | 124 | 2 / 42 / 70 / 40 |
| Dockerfile 基础镜像 | linux/amd64 | 89 | 64 | 1 / 26 / 27 / 35 |

Compose 两种架构每种均有 154 个“包 × 公告”命中、124 个去重公告 ID；**这两个架构与基础镜像重叠的记录不能简单相加**。每种 Compose 镜像中，应用目录命中 65 个，npm 工具链目录命中 38 个，OS 包命中 51 个。镜像扫描中另包含未分配 CVE 的 GHSA；保持“公告 ID”口径。

两个严重命中：

| CVE | 组件与位置 | 修复版本 | 触发条件与范围 |
| --- | --- | --- | --- |
| [CVE-2026-90711](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) | 应用 proxy-addr@2.0.7 | 2.0.8 | 需要错误的 IPv4 映射 IPv6 trust proxy 子网配置。当前工作区已是 2.0.8，且未配置 trust proxy；扫描没有证明线上满足触发条件。 |
| [CVE-2026-59873](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) | 镜像自带 npm → tar@6.2.1 | 本公告 7.5.19；其它 tar 命中需一并处理 | 解压不可信归档时可耗尽资源。属于 npm 安装/构建工具链；项目常规服务启动并不调用 tar 解压。 |

另外，镜像 OS 包 libcrypto3/libssl3@3.5.6-r0 与 zlib@1.3.2-r0 存在已知命中，应随受支持基础镜像和系统包更新一起处理。镜像 Node 是 20.20.2。Node 20 在 2026-04-30 结束官方支持，Dockerfile 的 node:20-alpine 应迁移到受支持 LTS，并验证 Alpine 系统包扫描结果。[官方生命周期](https://github.com/nodejs/Release/blob/main/schedule.json)。

镜像创建于 2026-09-28，缺少可用于对应当前 Git 提交的 revision 标签。本次发现它的 fast-uri 是 3.1.0（本地 3.1.8）、proxy-addr 是 2.0.7（本地 2.0.8），证明镜像与本地依赖不完全一致。容器结果只代表所记录的 digest，不能当作当前工作区构建产物或线上实际运行版本。

平台 digest：

- trivy-compose-amd64.json：`ghcr.io/aas-ee/open-web-search@sha256:0b49c1103dd3c04f3500a3d13af7aaef01f43c31db8c9f6b0a124408de723167`
- trivy-compose-arm64.json：`ghcr.io/aas-ee/open-web-search@sha256:7d0bab8503fb5e22adadb6cc42597b7fea58ec2fa6893bd1eb93c6abae061a52`
- trivy-node20-alpine-amd64.json：`node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293`

Dockerfile 同时存在 `npm ci || npm install` 回退，且最终镜像保留开发依赖。建议使用严格的 npm ci、多阶段构建及经过验证的运行依赖集合，以保证发布版本可重复并减少工具链残留；Playwright 虽列在 devDependencies，项目浏览器模式会动态加载它，不能不经验证就直接裁剪。

## 6. GitHub Actions 与外部浏览器

| 工作流引用 | 检查时解析版本 | 检查时提交 | OSV GitHub Actions 结果 |
| --- | --- | --- | --- |
| actions/checkout@v3 | v3.7.0 | a37ce9120846195fa4ece8f58b268e6043cb2f26 | 未命中 |
| docker/setup-buildx-action@v3 | v3.12.0 | 8d2750c68a42422c14e847fe6c8ac0403b4cbd6f | 未命中 |
| docker/setup-qemu-action@v3 | v3.7.0 | c7c53464625b32c7a7e944ae62b3e17d2b600130 | 未命中 |
| docker/login-action@v3 | v3.7.0 | c94ce9fb468520275223c153574b00df6fe4bcc9 | 未命中 |
| docker/build-push-action@v5 | v5.4.0 | ca052bb54ab0790a636c9b5f226502c73d547a25 | 未命中 |

这些 major tag 会移动，上表只代表检查时解析值，不代表历史工作流运行的版本；未进一步审计其内嵌工具或 GitHub 托管 runner 的系统镜像。

本地检测到 Google Chrome 154.0.8037.98；Microsoft Edge 154.0.4258.62。项目默认候选列表优先 Edge；实际选择还受 PLAYWRIGHT_EXECUTABLE_PATH、客户端模块及远端 WS/CDP 配置影响。Playwright 的包元数据声明 Chromium 151.0.7922.34，但没有在默认本地缓存目录发现已安装的该浏览器，不把元数据当作实际可执行版本。

微软官方在 2026-10-08 已发布 Edge 155.0.4283.45，本地 Edge 仍是上一主版本，建议更新并重新检查具体 CVE。[Edge 安全发布说明](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnotes-security)。Chrome 的 active stable releases API 显示本地 154.0.8037.98 仍在有效发布集合内，同时 155.0.8059.39 正在分批发布；不能仅按版本号排序将 API 中最大的版本当作当前全面发布版本。Chrome 发布博客的访问受到网络拦截，两个版本 API 原始响应已留存，尚未完成浏览器全部 CVE 的逐条匹配。外部 Playwright 模块、远端浏览器、用户最终部署的容器 digest 也未得到运行资产清单。Koffi/Playwright 内嵌本机二进制和捆绑代码没有单独 SBOM；这些是明确的覆盖边界，不能据 npm 未命中断言它们没有已知漏洞。

## 7. 建议处理顺序

1. 优先安排受支持 Node/容器基础镜像升级、同步系统包与 npm 工具链；用当前已更新的锁文件重新构建镜像，再按 digest 复扫。当前 latest 中的 proxy-addr 旧版本不能靠修改本地文件自动修复。
2. 将直接依赖最低版本提高至 @modelcontextprotocol/sdk ≥1.31.0、request-filtering-agent ≥3.2.1，更新并复核传递依赖，使第 2 节所有库达到所列修复线。express-rate-limit@8.3.1 固定了 ip-address@10.1.0，应更新父包及解析版本。
3. 执行类型编译、项目常规测试、HTTP/MCP transport 测试和 URL/重定向防护测试，再对最终锁文件及发布镜像复扫。单独安装新 Undici 不会替换 Node 内置的 Undici，必须处理运行时本身。
4. 为 CI 增加生产及全量 npm 审计、镜像漏洞扫描；保留 SBOM 和 image digest，按明确的可达性结论管理例外。更新真实使用的浏览器，并补齐远端资产版本清单。

## 8. 证据与重跑方式

[全部漏洞明细](D:/fosun/open-webSearchEE/docs/security/2026-10-09/VULNERABILITY-DETAILS.zh-CN.md) 包含 55 条工作区公告、运行时补充列表和完整容器命中。机器可读结果：[findings.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/findings.json)、[container-summary.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/container-summary.json)。完整依赖清单/SBOM：[dependency-inventory.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/dependency-inventory.json)、[sbom.cdx.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/sbom.cdx.json)。

原始证据：[npm-audit-full.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/npm-audit-full.json)、[npm-audit-production.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/npm-audit-production.json)、[osv-batch.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/osv-batch.json)、[osv-advisories.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/osv-advisories.json)、[trivy-workspace-lock.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/trivy-workspace-lock.json)、[trivy-compose-amd64.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/trivy-compose-amd64.json)、[trivy-compose-arm64.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/trivy-compose-arm64.json)、[trivy-node20-alpine-amd64.json](D:/fosun/open-webSearchEE/docs/security/2026-10-09/trivy-node20-alpine-amd64.json)。防护测试：[url-safety-tests.txt](D:/fosun/open-webSearchEE/docs/security/2026-10-09/url-safety-tests.txt)、[redirect-safety-tests.txt](D:/fosun/open-webSearchEE/docs/security/2026-10-09/redirect-safety-tests.txt)。

在项目根目录重跑（PowerShell）：

```powershell
npm.cmd audit --json --package-lock-only --include=dev --ignore-scripts --registry=https://registry.npmjs.org
npm.cmd audit --json --package-lock-only --omit=dev --ignore-scripts --registry=https://registry.npmjs.org
node docs/security/2026-10-09/inventory-and-osv.mjs
npm.cmd sbom --sbom-format=cyclonedx --package-lock-only --include=dev --include=optional --ignore-scripts
# 重新取得 Trivy 0.75.0 后，对本报告记录的具体 digest 执行：
trivy.exe image --image-src remote --platform linux/amd64 --scanners vuln --pkg-types os,library --format json <image@sha256:digest>
```

npm audit 有命中时退出码 1 是正常漏洞结果；应区别于网络/JSON错误。OSV 查询只发送公开包名和版本，未上传项目源码。本报告查询时间点之后新增、撤回或修订的公告可能改变结果。

已校验 package.json / package-lock.json 在此次检查中未改变。SHA256：

- package.json：`162d31e182536181b957bf6b35b2a1296661565db6da3583f098002e1b0b3b5c`
- package-lock.json：`be7c9c2e316a1c6906623a5a7c192178a3a601a4c384f3ed142c8ab4ea4d0250`
