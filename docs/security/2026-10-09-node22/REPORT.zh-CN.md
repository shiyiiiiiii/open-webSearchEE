# Node.js 22 运行环境调整记录

时间：2026-10-09T04:02:26.358Z（UTC）。按后续要求，当前构建及运行目标统一为 Node.js 22。

- Dockerfile 的构建、运行两个阶段均使用 node:22-alpine。
- package.json 和锁文件的 Node 范围为 ^22.23.3，限定 22.x 且最低 22.23.3；.nvmrc 指定 22.23.3，README 已同步。
- 185 个依赖锁定条目的版本保持不变，保留此前的 CVE 修复和 macOS 支持移除。

使用官方 SHA-256 校验通过的 Node.js 22.23.3 Windows 二进制执行验证：TypeScript 检查、构建通过；全量测试 38 个通过，1 个文章抓取联网用例因 TLS 连接建立之前中断，按现有运行器规则赦免。详情：[测试日志](npm-test.log)、[构建日志](build.log)、[验证数据](validation.json)。

npm audit 全量复查为 0 命中。内置 undici 6.28.1 的 OSV 查询为 0 命中。[npm 结果](npm-audit-all.json)、[运行时 undici 结果](runtime-undici-osv.json)。

远程基础镜像 amd64、arm64 均确认 Node.js 22.23.3 / Alpine 3.24.2；每种架构扫描均有 22 条包与公告组合命中，21 条位于 npm 工具链路径，1 条为 zlib 1.3.2-r0（修复版本 1.3.2-r1）。已有 Dockerfile 保留运行层移除 npm/Yarn 和 apk upgrade 的处理；这不是最终应用镜像构建或扫描结果。

基础镜像 digest：node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402。[amd64 扫描](trivy-node22-alpine-amd64.json)、[arm64 扫描](trivy-node22-alpine-arm64.json)。本机没有 Docker，因此未执行最终镜像构建。

Node.js 22.23.3 仍内置 OpenSSL 3.5.8，此前记录的上游版本范围候选仍然需要单独核实；不能将 npm 依赖零命中解释为整个运行环境无漏洞。本机全局 Node.js 22.23.2 未替换，低于本项目声明的最低版本。

版本及校验来源：[官方 Node.js 22.23.3 发布说明](https://nodejs.org/en/blog/release/v22.23.3)、[官方校验值](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)。

之前的 [依赖修复报告](../2026-10-09-remediation/REPORT.zh-CN.md) 和原始审计证据作为历史快照保留；当前运行环境配置以本次 Node.js 22 调整为准。
