# 依赖 CVE 修复及 macOS 支持移除记录

检查时间：2026-10-09T03:40:53.561Z（UTC）；项目：open-websearch@2.2.0。

当前工作区 npm 依赖的 npm audit、OSV 和 Trivy 复查均为 0 命中。原审计发现的 55 条公告（54 个 CVE 加 1 条仅有 GHSA 编号的公告）已不再命中当前锁定版本。该结论限定于应用依赖，不代表运行时、浏览器或已发布镜像全部无漏洞。

修复前基线保留在 [原始报告](../2026-10-09/REPORT.zh-CN.md)，此目录保存修复后的独立证据。

## 平台及浏览器支持调整

- package.json 和锁文件声明只支持 win32、linux；运行入口在其他平台以退出码 1 拒绝启动。
- 删除 macOS 浏览器应用路径、libSystem.B.dylib 加载及 Meta+A 快捷键分支；Linux 文件锁仅加载 glibc/musl。
- 开发依赖由 playwright 改为 playwright-core 1.62.1，彻底移除锁文件中的 playwright 及其 macOS 可选依赖 fsevents 2.3.2。
- Bing 的浏览器 User-Agent 和 navigator.platform 改为 Windows 标识；保留系统 Chrome/Edge、Playwright 核心客户端和远程浏览器连接能力。
- Chromium 下载命令和安装指引同步改为 playwright-core。掘金请求里的 iPhone User-Agent 是访问移动页面用的 HTTP 请求标识，不是 macOS 平台实现，保持原有抓取行为。
- Node.js 最低要求提升至 22.23.3，推荐受支持的 Node.js 24 LTS；本机原有 22.23.2 仍需用户的环境管理方式升级。本次验证使用临时官方 Node.js 24.21.0，并按官方 SHA-256 校验文件验证。

## 升级清单

| 依赖 | 修复前锁定版本 | 修复后锁定版本 | 位置 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.27.1 | 1.32.1 | 直接生产依赖 |
| request-filtering-agent | 3.2.0 | 3.2.1 | 直接生产依赖 |
| @hono/node-server | 1.19.11 | 2.1.4 | 间接生产依赖 |
| hono | 4.12.7 | 4.13.13 | 间接生产依赖 |
| express-rate-limit | 8.3.1 | 8.7.1 | 间接生产依赖 |
| ip-address | 10.1.0 | 10.7.3 | 间接生产依赖 |
| path-to-regexp | 8.3.0 | 8.4.2 | 间接生产依赖 |
| qs | 6.15.3 | 6.16.0 | 间接生产依赖 |
| undici | 6.24.0 | 6.29.0 | 间接生产依赖 |
| ws | 8.18.2 | 8.22.0 | 间接生产依赖 |

@hono/node-server 的 2.x 分支是新 MCP SDK 明确支持的版本范围；npm 正常解析完成更新，未使用 force 或强制 overrides。

## 复查范围与结果

| 检查 | 范围 | 结果 |
| --- | --- | --- |
| npm audit | 全部依赖 | 0 个受影响包、0 个漏洞 |
| npm audit --omit=dev | 生产依赖 | 0 个受影响包、0 个漏洞 |
| OSV | 178 个锁定包版本，加 2 个嵌入式包元数据，共 180 个查询 | 0 命中；嵌入式元数据不作为 npm 依赖组件计数 |
| Trivy 0.75.0 | 锁文件含开发依赖，共 178 个唯一包版本 | 0 命中 |
| npm ls / 实际安装清单 | 185 个锁条目、185 个已安装条目 | 无缺失、漂移或额外包 |

Trivy 数据库更新时间：2026-10-09T01:16:59.530806077Z。当前 CycloneDX SBOM 包含 178 个库组件及依赖关系：[sbom.cdx.json](sbom.cdx.json)。

原始结果：[npm 全量](npm-audit-all.json)、[npm 生产](npm-audit-production.json)、[OSV](osv-batch.json)、[Trivy](trivy-workspace-lock.json)、[依赖清单](dependency-inventory.json)。

## 构建和回归验证

- TypeScript 检查及 npm run build 成功；npm pack --dry-run 成功（98 个文件）。
- 使用官方校验通过的 Node.js 24.21.0 显式执行 npm CLI：39 个用例运行，38 个通过，1 个文章抓取联网用例收到远端 HTTP 521，按项目现有规则赦免。
- 已通过的覆盖包括 MCP、CLI、本地守护进程、URL/DNS/重定向安全、网页抓取、系统浏览器加载、隐藏窗口、页面池和 Bing 实际联网搜索。
- 首轮对话框集成测试的失败源于远端提示文案更换，并曾被现有测试运行器误记为网络赦免。测试已同时接受旧文案和当前文案，仍要求只捕获一次；随后全量测试中的该用例通过。
- 模拟 macOS 检查：启动退出码 1、系统浏览器候选为空、原生文件锁在加载本地库前拒绝执行。[平台验证](platform-smoke.json)。
- 干净生产依赖目录完成 npm ci --omit=dev，并保留同一锁定版本的 playwright-core；CLI、MCP、本地守护进程和浏览器客户端检查通过，typescript、playwright、fsevents 均不存在。测试依赖的测试资源单独复制用于验证。[生产目录验证](production-smoke.json)。
- 手动配置的跨重启并发测试按项目默认运行器规则排除。本机没有 Docker 或已安装的 WSL Linux 发行版，因此未执行 Linux 原生构建和最终 Docker 镜像构建。
- 保留工作区中并行进行的其他安全修复，并将新增用例纳入最后一轮测试；源码与测试资源在测试前后校验哈希一致。[验证源文件快照](validation-source-after.json)。

完整日志：[Node.js 24 全量测试](npm-test-node24.log)、[构建](build.log)、[生产安装](production-ci.log)、[生产 MCP](production-mcp-adapter.log)、[生产守护进程](production-local-daemon.log)。

## Docker 和运行时边界

Dockerfile 从已结束支持的 Node.js 20 Alpine 改为 Node.js 24 Alpine，使用 npm ci 固定锁文件，删除安装失败时回退 npm install 的路径。分阶段构建后的运行层保留构建产物、生产依赖及 playwright-core；移除 npm、npx、Yarn 和其他开发依赖，并执行 apk upgrade 更新系统包。

本次远程扫描的 Node.js 24 Alpine（Alpine 3.24.2 / Node.js 24.21.0）在 amd64、arm64 均为 22 条包与公告组合命中：8 高危、13 中危、1 低危。其中 21 条均位于基础镜像的 npm 工具链路径，Dockerfile 从运行层移除整个 npm 目录；另外 1 条为 zlib 1.3.2-r0 的 CVE-2026-85091，Alpine 修复版本为 1.3.2-r1，构建时通过 apk upgrade 获取。

基础镜像 digest：node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1。[amd64 原始扫描](trivy-node24-alpine-amd64.json)、[arm64 原始扫描](trivy-node24-alpine-arm64.json)。这不是修改后的最终应用镜像扫描；最终镜像必须实际构建后再验证包版本和漏洞结果。

官方 Node.js 24.21.0 Windows 测试运行时的 Node 核心公告匹配为 0；内置 undici 7.29.1 的 OSV 查询为 0，c-ares 1.34.8 高于先前 3 项 c-ares CVE 的修复阈值 1.34.7。这些结果来自实际运行时版本和上游数据。

该运行时仍内置 OpenSSL 3.5.8，按上游范围有 13 个候选 CVE，覆盖其全部的上游版本为 3.5.9：

| CVE | 上游严重性 | 条件相关功能 |
| --- | --- | --- |
| CVE-2026-35189 | Low | Excessive Memory Allocation in Relative CRLDP Processing |
| CVE-2026-35191 | Low | QUIC Unvalidated Amplification Credit may be Over Accounted |
| CVE-2026-42772 | Low | Potential CPU DoS via O(n^2) Fragment Reassembly in QUIC |
| CVE-2026-54872 | Low | Timing Side-Channel in Scalar Multiplication for Non-NIST EC Curves |
| CVE-2026-54873 | Low | QUIC STREAM Fragment Metadata DoS |
| CVE-2026-54875 | Low | Non-Constant-Time SM2 Scalar Multiplication on ARM64 and RISC-V |
| CVE-2026-72897 | Low | Out-of-Bounds Access After SSL_set_SSL_CTX() During a Handshake |
| CVE-2026-75804 | Low | QUIC Connection-Level Flow Control is Not Enforced for Streams |
| CVE-2026-75805 | Low | NULL Pointer Dereference in CMP Client Revocation Response Handling |
| CVE-2026-75806 | Low | Unauthenticated and Undersized DTLS 1.2 AEAD Record Causes DoS |
| CVE-2026-77696 | Low | Timing Side-Channel in SM2 Signature Generation |
| CVE-2026-84782 | High | DTLS Retransmits Handshake Messages From a Stale Buffer Offset |
| CVE-2026-84784 | Low | QUIC: Unbounded RETIRE_CONNECTION_ID Backlog |

这些是上游版本范围候选，不等同于已确认本应用可利用；Node 二进制回补状态与每项功能是否可达未全部验证。Node.js 24.21.0 是本次查到的最新 24 LTS 发布，但版本更新本身未把内置 OpenSSL 升至 3.5.9。apk upgrade 不会替换 Node 静态内置的 OpenSSL，因此这部分仍需后续官方 Node 修复版本或经过独立构建验证的运行时方案，不能通过升级 npm 包关闭。

之前扫描的 GHCR latest 镜像保持原状。源码和 Dockerfile 改动需要构建、发布、重新部署后才会作用于容器环境；本次没有执行发布或部署。

版本来源：[Node.js 官方发布索引](https://nodejs.org/dist/index.json)、[Node 核心安全公告](https://github.com/nodejs/security-wg/tree/main/vuln/core)、[OpenSSL 官方漏洞清单](https://openssl-library.org/news/vulnerabilities/)。[运行时分析](runtime-analysis.json)。

机器可读结果：[remediation-summary.json](remediation-summary.json)；证据哈希：[evidence-sha256.json](evidence-sha256.json)。
