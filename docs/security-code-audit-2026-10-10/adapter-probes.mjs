import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP = 'true';
const root = process.cwd();
const out = path.join(root, 'docs/security-code-audit-2026-10-10');
const fromBuild = name => import(pathToFileURL(path.join(root, 'build', name)));
const { startLocalDaemon } = await fromBuild('adapters/http/localDaemon.js');
const { createOpenWebSearchRuntime } = await fromBuild('runtime/createRuntime.js');
const { parseMcpHttpOptions } = await fromBuild('adapters/http/serverOptions.js');
const { RESOURCE_LIMITS } = await fromBuild('utils/resourceLimits.js');
const results = [], ids = [];
const request = (port, method, urlPath, body, extraHeaders = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: {
    Accept: 'application/json, text/event-stream',
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...extraHeaders
  } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
  });
  req.setTimeout(5000, () => req.destroy(new Error('Audit fixture request timeout')));
  req.on('error', reject); req.end(payload);
});
let calls = 0;
const runtime = createOpenWebSearchRuntime({ dependencies: { fetchJuejinArticle: async () => {
  calls++; return { content: 'AUDIT_STUB' };
} } });
const daemon = await startLocalDaemon(runtime, { port: 0 });
try {
  const response = await request(daemon.port, 'POST', '/fetch-juejin', { url: 'https://juejin.cn/post/1' }, {
    Host: 'attacker.invalid', Origin: 'http://attacker.invalid', 'Sec-Fetch-Site': 'cross-site'
  });
  results.push({ test: 'daemon-untrusted-host-and-origin', status: response.status, calls, response: JSON.parse(response.body) });
} finally { await daemon.close(); }
const reserved = http.createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const mcpPort = reserved.address().port;
await new Promise(resolve => reserved.close(resolve));
const child = spawn(process.execPath, ['build/index.js', '--port', String(mcpPort), '--local-only'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MODE: 'http', SEARCH_MODE: 'request', ENABLE_CORS: 'false', USE_PROXY: 'false',
    PLAYWRIGHT_WS_ENDPOINT: '', PLAYWRIGHT_CDP_ENDPOINT: '', OPEN_WEBSEARCH_QUIET_STARTUP: 'true' }
});
let output = ''; child.stdout.resume(); child.stderr.on('data', chunk => { output += chunk; });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('MCP startup timed out: ' + output)); }, 10000);
    const ready = () => { if (output.includes('HTTP server running')) { cleanup(); resolve(); } };
    const exited = () => { cleanup(); reject(new Error('MCP exited before ready: ' + output)); };
    const cleanup = () => { clearTimeout(timer); child.stderr.removeListener('data', ready); child.removeListener('exit', exited); };
    child.stderr.on('data', ready); child.once('exit', exited); ready();
  });
  const headers = { Host: 'attacker.invalid', Origin: 'http://attacker.invalid' };
  const init = await request(mcpPort, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'local-audit', version: '1' } } }, headers);
  const id = init.headers['mcp-session-id']; if (id) ids.push(id);
  const tools = id ? await request(mcpPort, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...headers, 'mcp-session-id': id }) : undefined;
  results.push({ test: 'mcp-no-auth-untrusted-host-origin', defaultBinding: parseMcpHttpOptions([], {}),
    initializeStatus: init.status, allocatedSession: Boolean(id), toolsListStatus: tools?.status,
    toolListReturned: tools?.body.includes('fetch_web') || tools?.body.includes('fetchWeb') || tools?.body.includes('search') });
  const initializeBody = { jsonrpc: '2.0', id: 3, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'quota-audit', version: '1' } } };
  for (let i = ids.length; i < RESOURCE_LIMITS.maxMcpSessions; i++) {
    const response = await request(mcpPort, 'POST', '/mcp', initializeBody);
    if (response.status !== 200 || !response.headers['mcp-session-id']) throw new Error('Unexpected quota fixture response');
    ids.push(response.headers['mcp-session-id']);
  }
  const overflow = await request(mcpPort, 'POST', '/mcp', initializeBody);
  const closedId = ids.shift();
  const closed = await request(mcpPort, 'DELETE', '/mcp', undefined, { 'mcp-session-id': closedId });
  const replacement = await request(mcpPort, 'POST', '/mcp', initializeBody);
  if (replacement.headers['mcp-session-id']) ids.push(replacement.headers['mcp-session-id']);
  results.push({ test: 'mcp-current-session-budget', configuredMaximum: RESOURCE_LIMITS.maxMcpSessions,
    configuredIdleTimeoutMs: RESOURCE_LIMITS.sessionIdleTimeoutMs, overflowStatus: overflow.status,
    closedStatus: closed.status, replacementStatus: replacement.status });
  for (const item of results) console.log(JSON.stringify(item));
} finally {
  for (const id of ids) await request(mcpPort, 'DELETE', '/mcp', undefined, { 'mcp-session-id': id }).catch(() => undefined);
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  fs.writeFileSync(path.join(out, 'adapter-probes.json'), JSON.stringify({
    fixture: 'Both servers bind only 127.0.0.1 on ephemeral ports. Daemon operations use a stub; MCP tools/list does not fetch upstream data.', results }, null, 2));
}
