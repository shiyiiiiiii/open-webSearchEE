import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const auditRoot = path.join(process.env.TEMP, 'open-websearch-security-audit-20261009');
const tests = ['test-url-safety','test-redirect-safety','test-browser-path-guard','test-http-request-options','test-core-target-validation','test-core-fetch-services','test-core-search','test-engine-normalization','test-cli-search','test-local-daemon','test-mcp-adapter','test-runtime','test-web-content','test-bing-parser','test-bing-http','test-duckduckgo-preload-url','test-baidu','test-sogou','test-hackernews','test-page-pool-lock'];
const results = [];
for (const test of tests) {
  const start = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'build/test', test + '.js')], {cwd:root,timeout:45000,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,OPEN_WEBSEARCH_QUIET_STARTUP:'true',OPEN_WEBSEARCH_INTEGRATION_TESTS:''}});
  const output = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(auditRoot, test + '.log'), output);
  const result={test,exitCode:r.status,signal:r.signal,error:r.error?.message,durationMs:Date.now()-start};
  results.push(result);
  console.log(JSON.stringify(result));
  fs.writeFileSync(path.join(auditRoot, 'regression-results.json'),JSON.stringify(results,null,2));
}
console.log(JSON.stringify({total:results.length,passed:results.filter(r=>r.exitCode===0).length,failed:results.filter(r=>r.exitCode!==0).length}));
