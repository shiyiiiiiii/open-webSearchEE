import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const root = process.cwd();
const output = path.join(root, 'docs/security/2026-10-11-c03');
const require = createRequire(path.join(root, 'package.json'));
const tests = [
    'test-browser-network-policy', 'test-page-pool-lock', 'test-browser-egress-proxy',
    'test-browser-path-guard', 'test-browser-redirect-safety', 'test-web-content',
    'test-url-safety', 'test-destination-ip-filter', 'test-http-request-options', 'test-redirect-safety',
    'test-core-fetch-services', 'test-core-target-validation', 'test-core-search',
    'test-engine-normalization', 'test-bing-parser', 'test-bing-http', 'test-cli-search',
    'test-local-daemon', 'test-mcp-adapter', 'test-runtime', 'test-duckduckgo-preload-url',
    'test-resource-limits', 'test-mcp-resource-limits'
];
async function execute(name, args) {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OPEN_WEBSEARCH_QUIET_STARTUP: 'true' }
    });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    fs.writeFileSync(path.join(output, name + '.log'), log);
    const preExisting = code !== 0 && [
        'test-resource-limits', 'test-mcp-resource-limits'
    ].includes(name) && /the fifth MCP session must be rejected|16 !== 4/.test(log);
    const item = { name, code, milliseconds: Date.now() - started, preExisting, skipped: /\bSKIP\b/.test(log) };
    console.log(JSON.stringify(item));
    return item;
}
const results = [await execute('build', ['node_modules/typescript/bin/tsc', '--pretty', 'false'])];
if (results[0].code === 0) {
    // Serialise native-capacity fixtures; every invocation still tests actual
    // concurrency internally. No external websites or personal browser state.
    for (const name of tests) results.push(await execute(name, ['build/test/' + name + '.js']));
}
const files = execFileSync('rg', ['--files', 'src'], { encoding: 'utf8', cwd: root }).trim().split(/\r?\n/);
const after = files.map(file => ({ path: file.replaceAll('\\', '/'), sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
const before = JSON.parse(fs.readFileSync(path.join(output, 'source-before.json'), 'utf8').replace(/^\uFEFF/, ''));
const initial = new Map(before.map(file => [file.path, file.sha256]));
fs.writeFileSync(path.join(output, 'source-after.json'), JSON.stringify(after, null, 2) + '\n');
const report = {
    date: '2026-10-11', timezone: 'Asia/Shanghai', node: process.version,
    playwright: require('playwright-core/package.json').version,
    results, passed: results.filter(item => item.code === 0).length,
    preExistingFailures: results.filter(item => item.preExisting).map(item => item.name),
    unexpectedFailures: results.filter(item => item.code !== 0 && !item.preExisting).map(item => item.name),
    changedExistingSources: after.filter(file => initial.has(file.path) && initial.get(file.path) !== file.sha256).map(file => file.path),
    newSources: after.filter(file => !initial.has(file.path)).map(file => file.path),
    deployment: { executed: false, reason: 'Docker is not installed and WSL has no usable distribution on this Windows development host' },
    liveBing: { executed: false, reason: 'Requires verified egress in the target deployment; no unsafe default-context fallback' }
};
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, preExistingFailures: report.preExistingFailures, unexpectedFailures: report.unexpectedFailures }));
process.exitCode = report.unexpectedFailures.length ? 1 : 0;
