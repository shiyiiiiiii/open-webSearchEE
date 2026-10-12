import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const out = path.join(root, 'docs/security-code-audit-2026-10-10');
const tests = [
  'test-url-safety', 'test-destination-ip-filter', 'test-redirect-safety',
  'test-http-request-options', 'test-browser-path-guard', 'test-core-target-validation',
  'test-core-fetch-services', 'test-core-search', 'test-engine-normalization',
  'test-cli-search', 'test-local-daemon', 'test-mcp-adapter', 'test-runtime',
  'test-web-content', 'test-bing-parser', 'test-bing-http',
  'test-duckduckgo-preload-url', 'test-baidu', 'test-sogou', 'test-hackernews',
  'test-page-pool-lock', 'test-resource-limits', 'test-mcp-resource-limits',
  'test-browser-redirect-safety'
];
const results = [];
for (const test of tests) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, 'build/test', test + '.js')], {
    cwd: root, timeout: 45000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, OPEN_WEBSEARCH_QUIET_STARTUP: 'true', OPEN_WEBSEARCH_INTEGRATION_TESTS: '',
      USE_PROXY: 'false', PLAYWRIGHT_WS_ENDPOINT: '', PLAYWRIGHT_CDP_ENDPOINT: '' }
  });
  const output = (result.stdout || '') + (result.stderr || '');
  fs.writeFileSync(path.join(out, test + '.log'), output);
  const item = { test, exitCode: result.status, signal: result.signal,
    error: result.error?.message, durationMs: Date.now() - started,
    skipped: /\bSKIP\b/.test(output) };
  results.push(item);
  fs.writeFileSync(path.join(out, 'regression-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(item));
}
const summary = { total: results.length, passed: results.filter(r => r.exitCode === 0).length,
  failed: results.filter(r => r.exitCode !== 0).length, skipped: results.filter(r => r.skipped).length };
console.log(JSON.stringify(summary));
process.exitCode = summary.failed ? 1 : 0;
