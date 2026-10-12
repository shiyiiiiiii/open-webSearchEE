import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP = 'true';
const root = process.cwd();
const out = path.join(root, 'docs/security-code-audit-2026-10-10');
const fromBuild = name => import(pathToFileURL(path.join(root, 'build', name)));
const { config } = await fromBuild('config.js');
const safety = await fromBuild('utils/urlSafety.js');
const networking = await fromBuild('utils/httpRequest.js');
const { RESOURCE_LIMITS } = await fromBuild('utils/resourceLimits.js');
const { fetchJuejinArticle } = await fromBuild('engines/juejin/fetchJuejinArticle.js');
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const received = [], connections = [], results = [];
const sink = http.createServer((req, res) => {
  received.push({ path: req.url, host: req.headers.host, cookie: req.headers.cookie, authorization: req.headers.authorization });
  if (req.url === '/oversize') { res.end(Buffer.alloc(RESOURCE_LIMITS.maxResponseBytes + 1, 'x')); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<html><body><div class="markdown-body">AUDIT_PRIVATE_CONTENT</div></body></html>');
});
const sinkPort = await listen(sink);
const source = http.createServer((req, res) => {
  res.writeHead(302, { Location: `http://${req.url === '/cookie-source' ? 'audit-cookie-sink.test' : 'audit-private.test'}:${sinkPort}/sink` });
  res.end();
});
const sourcePort = await listen(source);
const sockets = new Set();
const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
proxy.on('connect', (req, client, head) => {
  const target = new URL('http://' + req.url);
  const ports = { 'juejin.cn': sourcePort, 'audit-split.test': sinkPort,
    'audit-cookie-source.test': sourcePort, 'audit-cookie-sink.test': sinkPort, 'audit-private.test': sinkPort };
  const port = ports[target.hostname];
  if (!port || Number(target.port) !== port) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  connections.push(req.url);
  const upstream = net.connect(port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  sockets.add(client); sockets.add(upstream);
  client.on('close', () => { sockets.delete(client); upstream.destroy(); });
  upstream.on('close', () => sockets.delete(upstream));
  client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
});
const proxyPort = await listen(proxy);
const old = { useProxy: config.useProxy, proxyUrl: config.proxyUrl };
config.useProxy = true; config.proxyUrl = `http://127.0.0.1:${proxyPort}`;
try {
  const dnsChecks = [];
  safety.__setDnsLookupForTests(async host => { dnsChecks.push(host); return [{ address: '93.184.216.34' }]; });
  const split = await networking.requestWithSafeRedirects('GET', `http://audit-split.test:${sinkPort}/split-dns`, networking.buildAxiosRequestOptions({ timeout: 3000 }));
  results.push({ test: 'proxy-resolver-disagreement', nodeDnsChecks: [...dnsChecks],
    returnedPrivateContent: String(split.data).includes('AUDIT_PRIVATE_CONTENT'), privateHits: [...received] });
  safety.__setDnsLookupForTests(async host => [{ address: host === 'juejin.cn' ? '93.184.216.34' : '127.0.0.1' }]);
  const beforeRedirect = received.length;
  let redirectError;
  try { await fetchJuejinArticle(`http://juejin.cn:${sourcePort}/post/1`); }
  catch (error) { redirectError = error.message; }
  results.push({ test: 'juejin-private-redirect-blocked', error: redirectError, privateHits: received.slice(beforeRedirect) });
  safety.__setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
  const beforeCookie = received.length;
  await networking.requestWithSafeRedirects('GET', `http://audit-cookie-source.test:${sourcePort}/cookie-source`, networking.buildAxiosRequestOptions({
    timeout: 3000, headers: { Cookie: 'audit_session=DUMMY_NO_REAL_SECRET', Authorization: 'Bearer AUDIT_DUMMY' }
  }));
  results.push({ test: 'cross-origin-sensitive-header-forwarding', sinkRequests: received.slice(beforeCookie) });
  let oversizedError;
  try { await networking.requestWithSafeRedirects('GET', `http://audit-split.test:${sinkPort}/oversize`, networking.buildAxiosRequestOptions({ timeout: 3000 })); }
  catch (error) { oversizedError = error.message; }
  results.push({ test: 'http-response-budget-enforced', maximumBytes: RESOURCE_LIMITS.maxResponseBytes,
    fixtureBytes: RESOURCE_LIMITS.maxResponseBytes + 1, rejected: /maxContentLength|too large/i.test(oversizedError || ''), error: oversizedError });
  for (const item of results) console.log(JSON.stringify(item));
} finally {
  Object.assign(config, old); safety.__setDnsLookupForTests();
  for (const socket of sockets) socket.destroy();
  await Promise.all([close(proxy), close(source), close(sink)]);
  fs.writeFileSync(path.join(out, 'network-probes.json'), JSON.stringify({
    fixture: 'All sockets use audit-owned loopback services. A controlled CONNECT proxy models DNS disagreement. Credentials are fabricated.', connections, results }, null, 2));
}
