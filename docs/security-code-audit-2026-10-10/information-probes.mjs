import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP = 'true';
const root = process.cwd();
const out = path.join(root, 'docs/security-code-audit-2026-10-10');
const fakeProxyPassword = 'AUDIT_FAKE_PROXY_PASSWORD';
const fakeBrowserToken = 'AUDIT_FAKE_BROWSER_TOKEN';
const startup = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./build/config.js");'], {
  cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10000,
  env: { ...process.env, OPEN_WEBSEARCH_QUIET_STARTUP: 'false', USE_PROXY: 'true',
    PROXY_URL: `http://audit-user:${fakeProxyPassword}@127.0.0.1:9`,
    PLAYWRIGHT_WS_ENDPOINT: `ws://127.0.0.1:1/?token=${fakeBrowserToken}`, PLAYWRIGHT_CDP_ENDPOINT: '' }
});
const startupOutput = (startup.stdout || '') + (startup.stderr || '');
const fromBuild = name => import(pathToFileURL(path.join(root, 'build', name)));
const { config } = await fromBuild('config.js');
const { createOpenWebSearchRuntime } = await fromBuild('runtime/createRuntime.js');
const { startLocalDaemon } = await fromBuild('adapters/http/localDaemon.js');
const old = { useProxy: config.useProxy, playwrightWsEndpoint: config.playwrightWsEndpoint, playwrightCdpEndpoint: config.playwrightCdpEndpoint };
config.useProxy = false;
config.playwrightWsEndpoint = `ws://127.0.0.1:1/?token=${fakeBrowserToken}`;
config.playwrightCdpEndpoint = undefined;
const results = [{ test: 'startup-credential-logging', exitCode: startup.status,
  proxyPasswordInLog: startupOutput.includes(fakeProxyPassword), browserTokenInLog: startupOutput.includes(fakeBrowserToken) }];
let daemon;
try {
  daemon = await startLocalDaemon(createOpenWebSearchRuntime(), { port: 0 });
  const payload = JSON.stringify({ url: 'http://8.8.8.8/', renderMode: 'browser' });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path: '/fetch-web', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Audit fixture timeout')));
    req.on('error', reject); req.end(payload);
  });
  const data = JSON.parse(response.body);
  results.push({ test: 'remote-browser-token-in-daemon-error', status: response.status,
    errorCode: data.error?.code, browserTokenInError: response.body.includes(fakeBrowserToken),
    redactedMessage: data.error?.message?.replaceAll(fakeBrowserToken, '[REDACTED_AUDIT_TOKEN]') });
  for (const item of results) console.log(JSON.stringify(item));
} finally {
  if (daemon) await daemon.close();
  Object.assign(config, old);
  fs.writeFileSync(path.join(out, 'information-probes.json'), JSON.stringify({
    fixture: 'Credentials are fabricated. The unavailable WS endpoint is loopback port 1. Browser navigation never starts, so 8.8.8.8 is not contacted.', results }, null, 2));
}
