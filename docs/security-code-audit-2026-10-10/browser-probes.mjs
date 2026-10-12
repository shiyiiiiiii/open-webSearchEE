// All browser destinations are audit-owned loopback fixtures. No personal profile is used.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP = 'true';
const root = process.cwd();
const out = path.join(root, 'docs/security-code-audit-2026-10-10');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const { WebSocketServer } = require('ws');
const fromBuild = name => import(pathToFileURL(path.join(root, 'build', name)));
const safety = await fromBuild('utils/urlSafety.js');
const { installNavigationGuard } = await fromBuild('utils/browserCookies.js');
const { getSystemBrowserCandidates } = await fromBuild('utils/browserPaths.js');
const { config } = await fromBuild('config.js');
const { fetchWebContent } = await fromBuild('engines/web/fetchWebContent.js');
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const hits = [];
const canary = http.createServer((req, res) => {
  hits.push({ kind: 'http', path: req.url, host: req.headers.host });
  res.setHeader('Content-Type', 'text/html');
  res.end('<html><head><link rel="icon" href="data:,"></head><body><main>AUDIT_PRIVATE_SENTINEL</main></body></html>');
});
const wsServer = new WebSocketServer({ server: canary });
wsServer.on('connection', (socket, req) => {
  hits.push({ kind: 'websocket', path: req.url, origin: req.headers.origin });
  socket.send('AUDIT_PRIVATE_WS_SENTINEL');
  socket.close();
});
const canaryPort = await listen(canary);
let budgetGetterHits = 0;
const publicServer = http.createServer((req, res) => {
  if (req.url === '/budget-getter-entered') { budgetGetterHits++; res.writeHead(204); res.end(); return; }
  if (req.url === '/redirect' || req.url === '/redirect-image') {
    res.writeHead(302, { Location: `http://127.0.0.1:${canaryPort}/${req.url === '/redirect' ? 'redirect-target' : 'image-target'}` });
    res.end(); return;
  }
  let script = '';
  if (req.url === '/popup') script = `<script>window.open('http://127.0.0.1:${canaryPort}/popup-target','audit-popup')</script>`;
  if (req.url === '/websocket') script = `<script>const s=new WebSocket('ws://127.0.0.1:${canaryPort}/ws-target');s.onmessage=e=>document.body.append(e.data);</script>`;
  if (req.url === '/hang') script = `<script>window.Blob=function(){const x=new XMLHttpRequest();x.open('GET','/budget-getter-entered',false);x.send();for(;;){}};</script>`;
  const image = req.url === '/image-page' ? '<img src="/redirect-image">' : '';
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><link rel="icon" href="data:,"></head><body>Public fixture${image}${script}</body></html>`);
});
const publicPort = await listen(publicServer);
const dnsChecks = [];
safety.__setDnsLookupForTests(async hostname => {
  dnsChecks.push(hostname);
  if (!['audit-public.test', 'audit-destination.test'].includes(hostname)) throw new Error('Unexpected isolated fixture host');
  return [{ address: '93.184.216.34' }];
});
let browserServer, browser;
const results = [];
let metadata;
try {
  const executablePath = getSystemBrowserCandidates().find(candidate => fs.existsSync(candidate));
  if (!executablePath) throw new Error('No Chromium binary available');
  browserServer = await chromium.launchServer({ executablePath, headless: true, host: '127.0.0.1', args: [
    '--host-resolver-rules=MAP audit-public.test 127.0.0.1, MAP audit-destination.test 127.0.0.1',
    '--no-proxy-server', '--disable-background-networking'
  ] });
  browser = await chromium.connect({ wsEndpoint: browserServer.wsEndpoint() });
  metadata = { browserVersion: browser.version(), executablePath, node: process.version };
  for (const [test, endpoint] of [
    ['navigation-redirect-blocked', '/redirect'], ['image-redirect-blocked', '/image-page'],
    ['popup-first-request', '/popup'], ['websocket-request', '/websocket'],
    ['browser-resolver-disagreement', null]
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const before = hits.length;
    await installNavigationGuard(page);
    let navigationError;
    try {
      const url = endpoint ? `http://audit-public.test:${publicPort}${endpoint}` : `http://audit-destination.test:${canaryPort}/resolver-target`;
      await page.goto(url, { waitUntil: 'load', timeout: 7000 });
      await page.waitForTimeout(700);
    } catch (error) { navigationError = error.message; }
    const html = await page.content().catch(() => '');
    const item = { test, privateHits: hits.slice(before), finalUrl: page.url(), navigationError,
      pageCount: context.pages().length, bodyContainsPrivateSentinel: html.includes('AUDIT_PRIVATE_SENTINEL'),
      bodyContainsPrivateWebSocketSentinel: html.includes('AUDIT_PRIVATE_WS_SENTINEL') };
    results.push(item); console.log(JSON.stringify(item));
    await context.close();
  }
  const old = { playwrightWsEndpoint: config.playwrightWsEndpoint, playwrightCdpEndpoint: config.playwrightCdpEndpoint,
    playwrightNavigationTimeoutMs: config.playwrightNavigationTimeoutMs, useProxy: config.useProxy };
  try {
    config.playwrightWsEndpoint = browserServer.wsEndpoint();
    config.playwrightCdpEndpoint = undefined;
    config.useProxy = false;
    const before = hits.length;
    const result = await fetchWebContent(`http://audit-destination.test:${canaryPort}/tool-resolver-target`, 1000, { renderMode: 'browser' });
    const item = { test: 'fetchWebContent-browser-resolver-disagreement', privateHits: hits.slice(before),
      returnedPrivateContent: result.content.includes('AUDIT_PRIVATE_SENTINEL'), retrievalMethod: result.retrievalMethod, finalUrl: result.finalUrl };
    results.push(item); console.log(JSON.stringify(item));
    // One hostile renderer is observed for four seconds, then this script kills
    // only the browser it created. No unbounded stress test is performed.
    config.playwrightNavigationTimeoutMs = 1000;
    const started = Date.now();
    const operation = fetchWebContent(`http://audit-public.test:${publicPort}/hang`, 1000, { renderMode: 'browser' })
      .then(() => ({ settled: true, result: 'returned' }), error => ({ settled: true, result: 'rejected', error: error.message }));
    const observed = await Promise.race([operation, new Promise(resolve => setTimeout(() => resolve({ settled: false }), 4000))]);
    const budgetItem = { test: 'browser-evaluate-has-no-deadline', configuredNavigationTimeoutMs: 1000,
      observationMs: Date.now() - started, sizeEstimateGetterEntered: budgetGetterHits > 0, ...observed };
    await browserServer.kill();
    browserServer = undefined;
    budgetItem.afterOwnedBrowserKilled = await operation;
    results.push(budgetItem); console.log(JSON.stringify(budgetItem));
  } finally { Object.assign(config, old); }
} finally {
  if (browser) await browser.close();
  if (browserServer) await browserServer.close();
  safety.__setDnsLookupForTests();
  for (const socket of wsServer.clients) socket.terminate();
  wsServer.close();
  await Promise.all([close(publicServer), close(canary)]);
  fs.writeFileSync(path.join(out, 'browser-probes.json'), JSON.stringify({ metadata,
    fixture: 'Node preflight DNS is simulated as public while an isolated Chromium resolver maps test hosts to audit-owned loopback. This models resolver disagreement/rebinding; it does not claim real DNS infrastructure was attacked.', dnsChecks, results }, null, 2));
}
