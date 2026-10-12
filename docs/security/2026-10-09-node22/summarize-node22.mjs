import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const readAt = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const read = file => readAt(path.join(directory, file));
const save = (file, value) => fs.writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2) + '\n');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest = readAt(path.join(root, 'package.json'));
const lock = readAt(path.join(root, 'package-lock.json'));
const previous = readAt(path.join(directory, '../2026-10-09-remediation/dependency-inventory.json'));
const runtime = read('test-runtime.json');
const provenance = read('test-runtime-provenance.json');
const audit = read('npm-audit-all.json');
const undici = read('runtime-undici-osv.json');
const log = fs.readFileSync(path.join(directory, 'npm-test.log'), 'utf8');
const tests = {
  passed: [...log.matchAll(/^===== PASS (.+?) =====/gm)].map(match => match[1]),
  networkExcused: [...log.matchAll(/^===== EXCUSED (.+?):/gm)].map(match => match[1]),
  failed: [...log.matchAll(/^===== FAIL (.+?) \(/gm)].map(match => match[1]),
};
assert.equal(manifest.engines.node, '^22.23.3');
assert.equal(lock.packages[''].engines.node, manifest.engines.node);
assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(), '22.23.3');
const stages = [...fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').matchAll(/^FROM (\S+)/gm)].map(match => match[1]);
assert.deepEqual(stages, ['node:22-alpine', 'node:22-alpine']);
assert.equal(runtime.node, 'v22.23.3');
assert(provenance.verified);
for (const item of previous.locked) assert.equal(lock.packages[item.location].version, item.version, item.location);
assert.equal(audit.metadata.vulnerabilities.total, 0);
assert.equal(undici.response.vulns?.length || 0, 0);
assert.equal(tests.failed.length, 0);
assert.equal(tests.passed.length + tests.networkExcused.length, Number(log.match(/将并行运行 (\d+) 个当前/)?.[1]));
const images = ['amd64', 'arm64'].map(architecture => {
  const image = read('trivy-node22-alpine-' + architecture + '.json');
  assert(image.Metadata.ImageConfig.config.Env.includes('NODE_VERSION=22.23.3'));
  const findings = image.Results.flatMap(result => result.Vulnerabilities || []);
  return {
    architecture, digest: image.Metadata.RepoDigests, os: image.Metadata.OS,
    findings: findings.length,
    npmToolchainFindings: findings.filter(item => item.PkgPath?.startsWith('usr/local/lib/node_modules/npm/')).length,
    osFindings: findings.filter(item => !item.PkgPath).map(item => ({
      package: item.PkgName, installed: item.InstalledVersion, fixed: item.FixedVersion, cve: item.VulnerabilityID,
    })),
  };
});
const changedFiles = ['Dockerfile', 'package.json', 'package-lock.json', 'README.md', '.nvmrc'];
const summary = {
  generatedAt: new Date().toISOString(), nodeRange: manifest.engines.node, nvmrc: '22.23.3', stages,
  unchangedDependencyEntries: previous.locked.length, runtime, provenance,
  validation: { typecheck: 'passed', build: 'passed', tests, npmAudit: audit.metadata.vulnerabilities, runtimeUndiciOsvHits: 0 },
  images,
  limitations: ['Final application container not built; scans cover remote base images.', 'Existing global Node.js 22.23.2 was not replaced; checks use the verified temporary Node.js 22.23.3 executable.', 'Node.js 22.23.3 embeds OpenSSL 3.5.8; upstream version-range candidates recorded in the earlier audit still apply.'],
  sourceHashes: Object.fromEntries(changedFiles.map(file => [file, hash(path.join(root, file))])),
};
save('validation.json', summary);
const lines = [
  '# Node.js 22 运行环境调整记录',
  '',
  '时间：' + summary.generatedAt + '（UTC）。按后续要求，当前构建及运行目标统一为 Node.js 22。',
  '',
  '- Dockerfile 的构建、运行两个阶段均使用 node:22-alpine。',
  '- package.json 和锁文件的 Node 范围为 ^22.23.3，限定 22.x 且最低 22.23.3；.nvmrc 指定 22.23.3，README 已同步。',
  '- ' + previous.locked.length + ' 个依赖锁定条目的版本保持不变，保留此前的 CVE 修复和 macOS 支持移除。',
  '',
  '使用官方 SHA-256 校验通过的 Node.js 22.23.3 Windows 二进制执行验证：TypeScript 检查、构建通过；全量测试 ' + tests.passed.length + ' 个通过，' + tests.networkExcused.length + ' 个文章抓取联网用例因 TLS 连接建立之前中断，按现有运行器规则赦免。详情：[测试日志](npm-test.log)、[构建日志](build.log)、[验证数据](validation.json)。',
  '',
  'npm audit 全量复查为 0 命中。内置 undici ' + runtime.versions.undici + ' 的 OSV 查询为 0 命中。[npm 结果](npm-audit-all.json)、[运行时 undici 结果](runtime-undici-osv.json)。',
  '',
  '远程基础镜像 amd64、arm64 均确认 Node.js 22.23.3 / Alpine 3.24.2；每种架构扫描均有 22 条包与公告组合命中，21 条位于 npm 工具链路径，1 条为 zlib 1.3.2-r0（修复版本 1.3.2-r1）。已有 Dockerfile 保留运行层移除 npm/Yarn 和 apk upgrade 的处理；这不是最终应用镜像构建或扫描结果。',
  '',
  '基础镜像 digest：' + images[0].digest.join(', ') + '。[amd64 扫描](trivy-node22-alpine-amd64.json)、[arm64 扫描](trivy-node22-alpine-arm64.json)。本机没有 Docker，因此未执行最终镜像构建。',
  '',
  'Node.js 22.23.3 仍内置 OpenSSL ' + runtime.versions.openssl + '，此前记录的上游版本范围候选仍然需要单独核实；不能将 npm 依赖零命中解释为整个运行环境无漏洞。本机全局 Node.js 22.23.2 未替换，低于本项目声明的最低版本。',
  '',
  '版本及校验来源：[官方 Node.js 22.23.3 发布说明](https://nodejs.org/en/blog/release/v22.23.3)、[官方校验值](https://nodejs.org/dist/v22.23.3/SHASUMS256.txt)。',
  '',
  '之前的 [依赖修复报告](../2026-10-09-remediation/REPORT.zh-CN.md) 和原始审计证据作为历史快照保留；当前运行环境配置以本次 Node.js 22 调整为准。',
  '',
];
fs.writeFileSync(path.join(directory, 'REPORT.zh-CN.md'), lines.join('\n'));
save('evidence-sha256.json', {
  generatedAt: new Date().toISOString(),
  files: fs.readdirSync(directory).filter(file => file !== 'evidence-sha256.json' && fs.statSync(path.join(directory, file)).isFile())
    .map(file => ({ filename: file, sha256: hash(path.join(directory, file)) })),
});
console.log(JSON.stringify({ node: runtime.node, nodeRange: manifest.engines.node, unchangedDependencyEntries: previous.locked.length, tests: { passed: tests.passed.length, networkExcused: tests.networkExcused }, npmVulnerabilities: audit.metadata.vulnerabilities.total, baseImages: images }, null, 2));
