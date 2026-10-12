import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const baseline = path.join(directory, '../2026-10-09');
const readAt = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const read = filename => readAt(path.join(directory, filename));
const save = (filename, data) => fs.writeFileSync(path.join(directory, filename), JSON.stringify(data, null, 2) + '\n');
const hashAt = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const manifest = readAt(path.join(root, 'package.json'));
const lock = readAt(path.join(root, 'package-lock.json'));
const oldInventory = readAt(path.join(baseline, 'dependency-inventory.json'));
const inventory = read('dependency-inventory.json');
const osv = read('osv-batch.json');
const npmAll = read('npm-audit-all.json');
const npmProduction = read('npm-audit-production.json');
const trivy = read('trivy-workspace-lock.json');
const runtime = read('runtime-analysis.json');
const runtimeUndici = read('runtime-undici-osv.json');
const platformSmoke = read('platform-smoke.json');
const productionSmoke = read('production-smoke.json');
const nodeProvenance = read('test-runtime-provenance.json');
const scanner = readAt(path.join(baseline, 'trivy-scanner-metadata.json'));
const pack = read('npm-pack-dry-run.json');
const testLog = fs.readFileSync(path.join(directory, 'npm-test-node24.log'), 'utf8');
const validatedSources = read('validation-source-after.json');
assert.deepEqual(validatedSources.changedDuringTests, []);
for (const [filename, hash] of Object.entries(validatedSources.hashes)) {
  assert.equal(hashAt(path.join(root, filename)), hash, 'Source changed after validation: ' + filename);
}
const tests = {
  passed: [...testLog.matchAll(/^===== PASS (.+?) =====/gm)].map(match => match[1]),
  networkExcused: [...testLog.matchAll(/^===== EXCUSED (.+?):/gm)].map(match => match[1]),
  failed: [...testLog.matchAll(/^===== FAIL (.+?) \(/gm)].map(match => match[1]),
  log: 'npm-test-node24.log',
  invocation: 'verified Node.js 24.21.0 -> npm-cli.js test',
};
assert.equal(tests.failed.length, 0);
const expectedTestCount = Number(testLog.match(/将并行运行 (\d+) 个当前/)?.[1]);
assert(expectedTestCount > 0);
assert.equal(tests.passed.length + tests.networkExcused.length, expectedTestCount);
assert.deepEqual(tests.networkExcused, ['test-article-fetch-live.js']);
assert.match(testLog, /Request failed with status code 521/);
assert.equal(npmAll.metadata.vulnerabilities.total, 0);
assert.equal(npmProduction.metadata.vulnerabilities.total, 0);
assert.equal(osv.results.filter(item => item.vulnerabilities.length).length, 0);
assert.equal(trivy.Results.flatMap(result => result.Vulnerabilities || []).length, 0);
assert.equal(inventory.missing.length + inventory.mismatched.length + inventory.extraneous.length, 0);
assert(!Object.keys(lock.packages).some(location => /node_modules\/(?:fsevents|playwright)$/.test(location)));
assert.deepEqual(manifest.os, ['win32', 'linux']);
assert(nodeProvenance.verified);
assert.equal(platformSmoke.unsupportedStartupExit, 1);
assert.equal(productionSmoke.ciExitCode, 0);

const updatedNames = [
  '@modelcontextprotocol/sdk', 'request-filtering-agent', '@hono/node-server',
  'hono', 'express-rate-limit', 'ip-address', 'path-to-regexp', 'qs', 'undici', 'ws',
];
const versionsOf = (items, name) => [...new Set(items.filter(item => item.name === name).map(item => item.version))].join(', ');
const updates = updatedNames.map(name => ({
  name,
  before: versionsOf(oldInventory.locked, name),
  after: versionsOf(inventory.locked, name),
  direct: Object.hasOwn(manifest.dependencies, name),
}));
const removed = oldInventory.locked.filter(item => ['playwright', 'fsevents'].includes(item.name))
  .map(item => ({ name: item.name, version: item.version, reason: item.name === 'fsevents' ? 'macOS-only optional development dependency' : 'Replaced development client with playwright-core' }));

const grouped = new Map();
for (const item of inventory.locked) {
  const id = item.name + '@' + item.version;
  if (!grouped.has(id)) grouped.set(id, []);
  grouped.get(id).push(item);
}
const idAt = location => {
  const item = inventory.locked.find(candidate => candidate.location === location);
  return item ? item.name + '@' + item.version : null;
};
function resolveDependency(location, name) {
  let current = location;
  for (;;) {
    const candidate = (current ? current + '/' : '') + 'node_modules/' + name;
    if (lock.packages[candidate]) return candidate;
    if (!current) return null;
    const offset = current.lastIndexOf('/node_modules/');
    current = offset < 0 ? '' : current.slice(0, offset);
  }
}
const components = [...grouped].map(([id, locations]) => {
  const item = locations[0];
  const integrity = /^sha512-(.+)$/.exec(item.integrity || '');
  const [scope, packageName] = item.name.startsWith('@') ? item.name.split('/') : ['', item.name];
  const purl = 'pkg:npm/' + (scope ? encodeURIComponent(scope) + '/' : '') + encodeURIComponent(packageName) + '@' + item.version;
  return {
    type: 'library', 'bom-ref': id, name: item.name, version: item.version, purl,
    ...(integrity ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(integrity[1], 'base64').toString('hex') }] } : {}),
    properties: [
      { name: 'npm:locations', value: locations.map(item => item.location).join(', ') },
      { name: 'npm:development-only', value: String(locations.every(item => item.developmentOnly)) },
      { name: 'npm:direct-production', value: String(locations.some(item => item.directProduction)) },
      { name: 'npm:direct-development', value: String(locations.some(item => item.directDevelopment)) },
    ],
  };
});
const projectId = manifest.name + '@' + manifest.version;
const dependencies = [{
  ref: projectId,
  dependsOn: [...new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .map(name => idAt(resolveDependency('', name))).filter(Boolean))],
}];
for (const [id, locations] of grouped) {
  const references = new Set();
  for (const item of locations) {
    const data = lock.packages[item.location];
    for (const name of Object.keys({ ...data.dependencies, ...data.optionalDependencies, ...data.peerDependencies })) {
      const resolved = idAt(resolveDependency(item.location, name));
      if (resolved) references.add(resolved);
    }
  }
  dependencies.push({ ref: id, dependsOn: [...references].sort() });
}
save('sbom.cdx.json', {
  bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: 'urn:uuid:' + crypto.randomUUID(), version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', 'bom-ref': projectId, name: manifest.name, version: manifest.version },
    properties: [
      { name: 'audit:scope', value: 'npm lockfile, including development dependencies; embedded private package metadata is excluded from dependency components' },
      { name: 'audit:supported-platforms', value: manifest.os.join(', ') },
    ],
  },
  components, dependencies,
});

const images = ['amd64', 'arm64'].map(architecture => {
  const filename = 'trivy-node24-alpine-' + architecture + '.json';
  const data = read(filename);
  const findings = data.Results.flatMap(result => (result.Vulnerabilities || []).map(item => ({ ...item, target: result.Target })));
  return {
    architecture, report: filename, reference: data.Metadata.Reference, digest: data.Metadata.RepoDigests,
    os: data.Metadata.OS, node: data.Metadata.ImageConfig.config.Env.find(value => value.startsWith('NODE_VERSION=')),
    total: findings.length,
    severity: findings.reduce((result, item) => {
      result[item.Severity] = (result[item.Severity] || 0) + 1;
      return result;
    }, {}),
    npmToolchainFindings: findings.filter(item => item.PkgPath?.startsWith('usr/local/lib/node_modules/npm/')).length,
    osFindings: findings.filter(item => !item.PkgPath).map(item => ({ package: item.PkgName, version: item.InstalledVersion, fixed: item.FixedVersion, cve: item.VulnerabilityID })),
  };
});
assert(images.every(image => image.total === 22 && image.npmToolchainFindings === 21 && image.osFindings.length === 1));
const baselineFindings = readAt(path.join(baseline, 'findings.json'));
const previousCves = [...new Set(baselineFindings.findings.flatMap(item => item.cves || []))];
const trackedFiles = [
  'package.json', 'package-lock.json', 'Dockerfile', 'src/index.ts', 'src/utils/browserPaths.ts',
  'src/utils/nativeInterop.ts', 'src/engines/bing/bing.ts', 'src/test/test-bing-live.ts',
  'src/test/test-dialog-capture.ts', 'skills/open-websearch/references/setup.md', 'README.md',
];
const summary = {
  generatedAt: new Date().toISOString(),
  project: inventory.project,
  scope: 'Current workspace dependency remediation; not a rebuilt or deployed image audit',
  updates, removed,
  supportedPlatforms: manifest.os,
  minimumNode: manifest.engines.node,
  inventory: inventory.counts,
  crossValidation: {
    npmAll: npmAll.metadata.vulnerabilities,
    npmProduction: npmProduction.metadata.vulnerabilities,
    osvPackageVersionsQueried: osv.packageVersionsQueried,
    osvAffectedPackageVersions: 0,
    trivyUniquePackageVersions: trivy.Results.flatMap(result => result.Packages || []).length,
    trivyFindings: 0,
    previousAdvisories: baselineFindings.findings.length,
    previousCves: previousCves.length,
    missing: inventory.missing, mismatched: inventory.mismatched, extraneous: inventory.extraneous,
  },
  validation: {
    build: { command: 'npm run build', exitCode: 0, log: 'build.log' },
    tests, platformSmoke, productionSmoke, pack: { files: pack[0].entryCount, size: pack[0].size },
    sourceSnapshot: { files: Object.keys(validatedSources.hashes).length, checkedAt: validatedSources.capturedAt, changedDuringTests: validatedSources.changedDuringTests },
  },
  scanner,
  baseImages: images,
  runtime: {
    node: runtime.runtime.node, provenance: nodeProvenance,
    coreFeedMatches: runtime.core.matches.length,
    undici: runtime.runtime.versions.undici, undiciOsvHits: runtimeUndici.response.vulns?.length || 0,
    cares: runtime.cares,
    opensslVersion: runtime.openssl.version,
    opensslVersionRangeCandidates: runtime.openssl.matches,
  },
  limitations: [
    'The existing system Node.js 22.23.2 was not replaced; verification uses a checksum-verified temporary official Node.js 24.21.0 executable.',
    'Docker and Linux native binding builds were not run; the Windows production-layout smoke is not a container build.',
    'The existing published GHCR image was not rebuilt, redeployed, or changed.',
    'Alpine zlib upgrades and npm/yarn removal are implemented in Dockerfile; the resulting image still requires an actual build and scan.',
    'Node.js 24.21.0 embeds OpenSSL 3.5.8: 13 upstream version-range candidates remain. Feature reachability and binary backports have not been confirmed. apk upgrade does not replace Node.js statically embedded OpenSSL.',
    'Live article fetch returned HTTP 521; the runner excused this test. The manually configured cross-restart concurrency test is excluded by the existing default runner.',
  ],
  sourceHashes: Object.fromEntries(trackedFiles.map(filename => [filename, hashAt(path.join(root, filename))])),
};
save('remediation-summary.json', summary);
save('validation.json', summary.validation);
save('container-summary.json', images);

const lines = [
  '# 依赖 CVE 修复及 macOS 支持移除记录',
  '',
  '检查时间：' + summary.generatedAt + '（UTC）；项目：' + projectId + '。',
  '',
  '当前工作区 npm 依赖的 npm audit、OSV 和 Trivy 复查均为 0 命中。原审计发现的 55 条公告（54 个 CVE 加 1 条仅有 GHSA 编号的公告）已不再命中当前锁定版本。该结论限定于应用依赖，不代表运行时、浏览器或已发布镜像全部无漏洞。',
  '',
  '修复前基线保留在 [原始报告](../2026-10-09/REPORT.zh-CN.md)，此目录保存修复后的独立证据。',
  '',
  '## 平台及浏览器支持调整',
  '',
  '- package.json 和锁文件声明只支持 win32、linux；运行入口在其他平台以退出码 1 拒绝启动。',
  '- 删除 macOS 浏览器应用路径、libSystem.B.dylib 加载及 Meta+A 快捷键分支；Linux 文件锁仅加载 glibc/musl。',
  '- 开发依赖由 playwright 改为 playwright-core 1.62.1，彻底移除锁文件中的 playwright 及其 macOS 可选依赖 fsevents 2.3.2。',
  '- Bing 的浏览器 User-Agent 和 navigator.platform 改为 Windows 标识；保留系统 Chrome/Edge、Playwright 核心客户端和远程浏览器连接能力。',
  '- Chromium 下载命令和安装指引同步改为 playwright-core。掘金请求里的 iPhone User-Agent 是访问移动页面用的 HTTP 请求标识，不是 macOS 平台实现，保持原有抓取行为。',
  '- Node.js 最低要求提升至 22.23.3，推荐受支持的 Node.js 24 LTS；本机原有 22.23.2 仍需用户的环境管理方式升级。本次验证使用临时官方 Node.js 24.21.0，并按官方 SHA-256 校验文件验证。',
  '',
  '## 升级清单',
  '',
  '| 依赖 | 修复前锁定版本 | 修复后锁定版本 | 位置 |',
  '| --- | --- | --- | --- |',
  ...updates.map(item => '| ' + item.name + ' | ' + item.before + ' | ' + item.after + ' | ' + (item.direct ? '直接生产依赖' : '间接生产依赖') + ' |'),
  '',
  '@hono/node-server 的 2.x 分支是新 MCP SDK 明确支持的版本范围；npm 正常解析完成更新，未使用 force 或强制 overrides。',
  '',
  '## 复查范围与结果',
  '',
  '| 检查 | 范围 | 结果 |',
  '| --- | --- | --- |',
  '| npm audit | 全部依赖 | 0 个受影响包、0 个漏洞 |',
  '| npm audit --omit=dev | 生产依赖 | 0 个受影响包、0 个漏洞 |',
  '| OSV | ' + inventory.counts.uniqueLocked + ' 个锁定包版本，加 2 个嵌入式包元数据，共 ' + osv.packageVersionsQueried + ' 个查询 | 0 命中；嵌入式元数据不作为 npm 依赖组件计数 |',
  '| Trivy ' + scanner.version + ' | 锁文件含开发依赖，共 ' + inventory.counts.uniqueLocked + ' 个唯一包版本 | 0 命中 |',
  '| npm ls / 实际安装清单 | ' + inventory.counts.lockEntries + ' 个锁条目、' + inventory.counts.installedEntries + ' 个已安装条目 | 无缺失、漂移或额外包 |',
  '',
  'Trivy 数据库更新时间：' + scanner.database.UpdatedAt + '。当前 CycloneDX SBOM 包含 ' + components.length + ' 个库组件及依赖关系：[sbom.cdx.json](sbom.cdx.json)。',
  '',
  '原始结果：[npm 全量](npm-audit-all.json)、[npm 生产](npm-audit-production.json)、[OSV](osv-batch.json)、[Trivy](trivy-workspace-lock.json)、[依赖清单](dependency-inventory.json)。',
  '',
  '## 构建和回归验证',
  '',
  '- TypeScript 检查及 npm run build 成功；npm pack --dry-run 成功（' + pack[0].entryCount + ' 个文件）。',
  '- 使用官方校验通过的 Node.js 24.21.0 显式执行 npm CLI：' + expectedTestCount + ' 个用例运行，' + tests.passed.length + ' 个通过，1 个文章抓取联网用例收到远端 HTTP 521，按项目现有规则赦免。',
  '- 已通过的覆盖包括 MCP、CLI、本地守护进程、URL/DNS/重定向安全、网页抓取、系统浏览器加载、隐藏窗口、页面池和 Bing 实际联网搜索。',
  '- 首轮对话框集成测试的失败源于远端提示文案更换，并曾被现有测试运行器误记为网络赦免。测试已同时接受旧文案和当前文案，仍要求只捕获一次；随后全量测试中的该用例通过。',
  '- 模拟 macOS 检查：启动退出码 1、系统浏览器候选为空、原生文件锁在加载本地库前拒绝执行。[平台验证](platform-smoke.json)。',
  '- 干净生产依赖目录完成 npm ci --omit=dev，并保留同一锁定版本的 playwright-core；CLI、MCP、本地守护进程和浏览器客户端检查通过，typescript、playwright、fsevents 均不存在。测试依赖的测试资源单独复制用于验证。[生产目录验证](production-smoke.json)。',
  '- 手动配置的跨重启并发测试按项目默认运行器规则排除。本机没有 Docker 或已安装的 WSL Linux 发行版，因此未执行 Linux 原生构建和最终 Docker 镜像构建。',
  '- 保留工作区中并行进行的其他安全修复，并将新增用例纳入最后一轮测试；源码与测试资源在测试前后校验哈希一致。[验证源文件快照](validation-source-after.json)。',
  '',
  '完整日志：[Node.js 24 全量测试](npm-test-node24.log)、[构建](build.log)、[生产安装](production-ci.log)、[生产 MCP](production-mcp-adapter.log)、[生产守护进程](production-local-daemon.log)。',
  '',
  '## Docker 和运行时边界',
  '',
  'Dockerfile 从已结束支持的 Node.js 20 Alpine 改为 Node.js 24 Alpine，使用 npm ci 固定锁文件，删除安装失败时回退 npm install 的路径。分阶段构建后的运行层保留构建产物、生产依赖及 playwright-core；移除 npm、npx、Yarn 和其他开发依赖，并执行 apk upgrade 更新系统包。',
  '',
  '本次远程扫描的 Node.js 24 Alpine（Alpine 3.24.2 / Node.js 24.21.0）在 amd64、arm64 均为 22 条包与公告组合命中：8 高危、13 中危、1 低危。其中 21 条均位于基础镜像的 npm 工具链路径，Dockerfile 从运行层移除整个 npm 目录；另外 1 条为 zlib 1.3.2-r0 的 CVE-2026-85091，Alpine 修复版本为 1.3.2-r1，构建时通过 apk upgrade 获取。',
  '',
  '基础镜像 digest：' + images[0].digest.join(', ') + '。[amd64 原始扫描](trivy-node24-alpine-amd64.json)、[arm64 原始扫描](trivy-node24-alpine-arm64.json)。这不是修改后的最终应用镜像扫描；最终镜像必须实际构建后再验证包版本和漏洞结果。',
  '',
  '官方 Node.js 24.21.0 Windows 测试运行时的 Node 核心公告匹配为 0；内置 undici 7.29.1 的 OSV 查询为 0，c-ares 1.34.8 高于先前 3 项 c-ares CVE 的修复阈值 1.34.7。这些结果来自实际运行时版本和上游数据。',
  '',
  '该运行时仍内置 OpenSSL 3.5.8，按上游范围有 ' + runtime.openssl.matches.length + ' 个候选 CVE，覆盖其全部的上游版本为 3.5.9：',
  '',
  '| CVE | 上游严重性 | 条件相关功能 |',
  '| --- | --- | --- |',
  ...runtime.openssl.matches.map(item => '| ' + item.cve + ' | ' + item.severity + ' | ' + item.title + ' |'),
  '',
  '这些是上游版本范围候选，不等同于已确认本应用可利用；Node 二进制回补状态与每项功能是否可达未全部验证。Node.js 24.21.0 是本次查到的最新 24 LTS 发布，但版本更新本身未把内置 OpenSSL 升至 3.5.9。apk upgrade 不会替换 Node 静态内置的 OpenSSL，因此这部分仍需后续官方 Node 修复版本或经过独立构建验证的运行时方案，不能通过升级 npm 包关闭。',
  '',
  '之前扫描的 GHCR latest 镜像保持原状。源码和 Dockerfile 改动需要构建、发布、重新部署后才会作用于容器环境；本次没有执行发布或部署。',
  '',
  '版本来源：[Node.js 官方发布索引](https://nodejs.org/dist/index.json)、[Node 核心安全公告](https://github.com/nodejs/security-wg/tree/main/vuln/core)、[OpenSSL 官方漏洞清单](https://openssl-library.org/news/vulnerabilities/)。[运行时分析](runtime-analysis.json)。',
  '',
  '机器可读结果：[remediation-summary.json](remediation-summary.json)；证据哈希：[evidence-sha256.json](evidence-sha256.json)。',
  '',
];
fs.writeFileSync(path.join(directory, 'REPORT.zh-CN.md'), lines.join('\n'));
const evidence = fs.readdirSync(directory).filter(filename => filename !== 'evidence-sha256.json' && fs.statSync(path.join(directory, filename)).isFile())
  .map(filename => ({ filename, bytes: fs.statSync(path.join(directory, filename)).size, sha256: hashAt(path.join(directory, filename)) }));
save('evidence-sha256.json', { generatedAt: new Date().toISOString(), files: evidence });
console.log(JSON.stringify({ updates: updates.length, removed, scans: summary.crossValidation, tests: { passed: tests.passed.length, networkExcused: tests.networkExcused }, sbomComponents: components.length, evidenceFiles: evidence.length }, null, 2));
