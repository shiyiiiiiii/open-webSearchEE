# 审计证据与复现

对应报告：[security-code-audit-2026-10-09.md](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-09.md)。

| 文件 | 用途 |
| --- | --- |
| npm-audit.json / npm-audit-production.json | npm 原始完整与生产依赖告警快照 |
| dependency-summary.json | 锁定版本、风险、公告与传递依赖归纳 |
| regression-results.json / run-regression.mjs | 20 项选定回归测试结果及执行脚本 |
| adapter-probes.json / adapter-probes.mjs | 入口校验、未认证 MCP、重复引擎放大、配置凭证日志 |
| browser-guard-probe.json / browser-guard-probe.mjs | 真实浏览器守卫：主导航跳转、图片跳转、弹窗首请求 |
| network-probes.json / network-probes.mjs | 代理 DNS 分歧、掘金重定向、跨域敏感头 |
| resource-probes.json / resource-probes.mjs | 专用抓取请求选项、大响应、文章 URL 验证 |
| manifest.json | 环境、范围、源码及证据 SHA-256，测试摘要 |

这些脚本保留原审计实现，需从项目根目录运行；相对 import 指向已构建的 build。脚本输出写入 Windows TEMP/open-websearch-security-audit-20261009，不会覆盖本目录交付的 JSON 快照。使用 Node 22、现有锁文件依赖及 Playwright 1.61.1；浏览器脚本会查找可用系统浏览器并创建独立临时实例，不接管已登录浏览器。

本地网络脚本仅连接自建 loopback 服务，用虚构域名和测试 DNS hook 模拟公网。服务端口自动分配；MCP 子进程使用项目现有所有接口绑定行为，运行完清理其会话和进程。资源脚本替换 Axios 请求，不做大流量上游请求。所有凭证值均为虚构审计数据。复现主导航测试时外层工具的最终 URL 拒绝不在此 helper 级测试内；需要按报告区分“私网访问已发生”和“工具最终是否返回内容”。

## 重放命令（PowerShell）

依赖及构建已准备时，无需重复 npm ci。npm audit 有告警时退出码非零是正常结果，应检查 JSON 中的 error 字段来区分告警与审计失败。

~~~powershell
Set-Location 'D:\fosun\open-webSearchEE'
$scanOutput = Join-Path $env:TEMP 'open-websearch-security-audit-20261009'
New-Item -ItemType Directory -Path $scanOutput -Force | Out-Null

# 仅在依赖尚未准备时执行
npm ci --ignore-scripts --no-audit --no-fund
npm run build

npm audit --package-lock-only --json |
    Set-Content -LiteralPath (Join-Path $scanOutput 'npm-audit.json') -Encoding utf8
npm audit --omit=dev --package-lock-only --json |
    Set-Content -LiteralPath (Join-Path $scanOutput 'npm-audit-production.json') -Encoding utf8

node docs/security-code-audit-2026-10-09/run-regression.mjs
node docs/security-code-audit-2026-10-09/adapter-probes.mjs
node docs/security-code-audit-2026-10-09/browser-guard-probe.mjs
node docs/security-code-audit-2026-10-09/network-probes.mjs
node docs/security-code-audit-2026-10-09/resource-probes.mjs
~~~

resource-probes.mjs 会读取临时目录的 npm-audit.json，并结合当前 package-lock.json 生成依赖摘要。重放依赖审计访问 npm 公告服务，结果可能随公告更新而变化；不能把新结果当作 2026-10-09 快照。

修复之后，期望浏览器和代理私网访问被阻止、Cookie 不跨域、异常 Host / Origin 和未认证请求被拒绝、重复引擎不放大执行。当前脚本是观测性复现，会记录行为；除既有 regression runner 的测试结果外，不应只靠进程退出码判断漏洞是否修复。

单项 regression 进程最长 45 秒；只运行该脚本列出的 20 项测试，并关闭显式在线集成开关。这不是完整 npm test 或 live 集成测试结果。
