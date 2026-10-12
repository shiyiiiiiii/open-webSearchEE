import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'docs/security/2026-10-11-c03-p2-fix');
const require = createRequire(path.join(root, 'package.json'));
const checks = [
  ['build', 'node_modules/typescript/bin/tsc', '--pretty', 'false'],
  ...['test-browser-network-policy', 'test-page-pool-lock', 'test-browser-egress-proxy',
    'test-browser-path-guard', 'test-browser-redirect-safety', 'test-web-content',
    'test-core-fetch-services'].map(name => [name, `build/test/${name}.js`]),
  ['probe-frame-lifecycle', 'docs/security/2026-10-11-c03-review/probe-frame-lifecycle.mjs']
];
const results = [];
for (const [name, ...args] of checks) {
  const started = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'],
    env: {...process.env, OPEN_WEBSEARCH_QUIET_STARTUP:'true'}
  });
  let log = '';
  child.stdout.on('data', chunk => {log += chunk;});
  child.stderr.on('data', chunk => {log += chunk;});
  const timeout = setTimeout(() => child.kill(), 120000);
  const code = await new Promise((resolve,reject) => {
    child.once('error',reject); child.once('close',resolve);
  }).finally(() => clearTimeout(timeout));
  writeFileSync(path.join(output, `${name}.log`), log);
  const result = {name, code, milliseconds:Date.now()-started, skipped:/\bSKIP\b/.test(log)};
  results.push(result);
  console.log(JSON.stringify(result));
  if (code !== 0 || result.skipped) break;
}
const changedSources = JSON.parse(readFileSync(path.join(root,
  'docs/security/2026-10-11-c03-review/source-before.json'),'utf8').replace(/^\uFEFF/,''))
  .filter(file => createHash('sha256').update(readFileSync(path.join(root,file.path))).digest('hex') !== file.sha256)
  .map(file => file.path);
const report = {
  date:'2026-10-11', node:process.version, playwright:require('playwright-core/package.json').version,
  results, passed:results.filter(item=>item.code===0 && !item.skipped).length,
  complete:results.length===checks.length && results.every(item=>item.code===0 && !item.skipped),
  changedSources, deploymentExecuted:false
};
writeFileSync(path.join(output,'verification.json'), JSON.stringify(report,null,2)+'\n');
process.exitCode = report.complete ? 0 : 1;
