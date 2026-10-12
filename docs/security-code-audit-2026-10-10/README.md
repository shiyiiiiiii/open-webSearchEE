# 2026-10-10 审计证据

最终结论见 [主报告](D:/fosun/open-webSearchEE/docs/security-code-audit-2026-10-10.md)。证据针对当前工作区，不只针对 Git HEAD。仅在本目录增加审计脚本 / 记录；构建产生忽略的 build 产物，不修改业务源码。

## 文件对应关系

| 文件 | 用途 |
| --- | --- |
| `adapter-probes.json` | C01 / C02：无认证、非法 Host / Origin；当前 MCP 会话预算 |
| `network-probes.json` | C04 / C05：代理解析分歧、跨源敏感头；掘金逐跳拒绝及 HTTP 大小预算 |
| `browser-probes.json` | C03 / C04 / C07：真实浏览器守卫、完整抓取解析分歧、页面求值期限 |
| `information-probes.json` | C06：虚构配置秘密的日志及未认证错误响应泄露 |
| `metadata-probe.json` | C08：从源码抽取原函数，以模拟文件 / 进程操作验证失效与负 PID；零真实信号 |
| `static-inventory.json` | 全部 src TypeScript 的摘要、AST 调用点、C09 敏感字面量位置；字面量原文不记录 |
| `resource-probes.json` | 当前资源预算的补充边界验证 |
| `regression-results.json`、`test-*.log` | 最终 24 项选择性回归：22 通过、2 失败、0 跳过 |
| `regression-sandbox-attempt.json` | 最初受环境网络限制的尝试；不用于最终通过率 |
| `npm-audit-all.json`、`npm-audit-production.json` | 当天重新查询的 npm 公告结果，全量与生产均 0 告警 |
| `npm-installed-tree.json`、`dependency-publicness.json` | 安装依赖树及公开 registry 来源验证 |
| `source-before.json`、`source-after.json`、`git-status-*.txt` | 审计前后工作区记录，防止将已有用户修改算作审计修改 |
| `build.log` | TypeScript 编译输出；成功构建没有诊断文本 |
| `findings.json`、`manifest.json` | 结构化问题索引、环境、验证统计、源码不变检查及证据摘要 |

## 复现条件

从项目根目录运行，使用项目要求的 Node 22.23.3 或符合 engines 的版本与当前锁文件安装的依赖。此次实际用的 Node 路径和 SHA-256 保存在 manifest。先构建当前源码，避免复现旧的 build 文件：

```powershell
node node_modules/typescript/bin/tsc
node docs/security-code-audit-2026-10-10/run-regression.mjs
node docs/security-code-audit-2026-10-10/adapter-probes.mjs
node docs/security-code-audit-2026-10-10/network-probes.mjs
node docs/security-code-audit-2026-10-10/browser-probes.mjs
node docs/security-code-audit-2026-10-10/information-probes.mjs
node docs/security-code-audit-2026-10-10/resource-probes.mjs
node docs/security-code-audit-2026-10-10/metadata-probe.mjs
node docs/security-code-audit-2026-10-10/static-inventory.mjs
```

测试脚本顺序执行，允许自建 loopback HTTP / WebSocket / CONNECT 服务和临时隔离浏览器。`run-regression.mjs` 当前预期退出 1，因为两项原有断言仍使用旧预算；它不是“全套测试”。browser 脚本需要可用的系统 Chromium / Edge 及 playwright-core，版本不同可能影响网络策略；会在有界观察后停止自己创建的测试浏览器。metadata 脚本只使用 VM 替身，不对真实 PID 发信号。不要把测试 DNS hook 或 loopback 放行配置加入生产服务。

需要重新查询依赖公告时运行以下命令；仅重定向 JSON 输出，不将已有日志或密钥作为输入：

```powershell
npm audit --package-lock-only --json | Set-Content -Encoding UTF8 docs/security-code-audit-2026-10-10/npm-audit-all.json
npm audit --omit=dev --package-lock-only --json | Set-Content -Encoding UTF8 docs/security-code-audit-2026-10-10/npm-audit-production.json
npm ls --all --json | Set-Content -Encoding UTF8 docs/security-code-audit-2026-10-10/npm-installed-tree.json
```

依赖查询需要外网；其他漏洞验证面向自建服务。配置输出测试使用假密码和假 token，硬编码 Cookie 值不复制到证据。本目录不是用于直接对生产服务运行的渗透脚本。

摘要复核可运行 `node docs/security-code-audit-2026-10-10/finalize-audit.mjs`；该脚本比较当前文件与审计时快照，并重新生成 manifest。重新执行任何脚本会覆盖其同名结果，若需保留原始审计证据请先保存目录副本。
