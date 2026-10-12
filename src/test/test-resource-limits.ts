import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { config } from '../config.js';
import { parseMcpHttpOptions } from '../adapters/http/serverOptions.js';
import { SessionLimiter } from '../adapters/http/sessionLimiter.js';
import { parseServeArgs } from '../cli/runCli.js';
import { shouldCreateFullRuntimeForInvocation } from '../runtime/runtimeSelection.js';
import { createSearchService } from '../core/search/searchService.js';
import { createArticleFetchService } from '../core/fetch/fetchServices.js';
import { RESOURCE_LIMITS } from '../utils/resourceLimits.js';
import { buildAxiosRequestOptions, requestWithSafeRedirects, __setAxiosRequestForTests } from '../utils/httpRequest.js';
import { __setDnsLookupForTests } from '../utils/urlSafety.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';

async function testDaemonCapacityResponse(): Promise<void> {
    let release!: () => void;
    let ready!: () => void;
    let started = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const allStarted = new Promise<void>(resolve => { ready = resolve; });
    const runtime = createOpenWebSearchRuntime({ dependencies: {
        fetchJuejinArticle: async () => { if (++started === 4) ready(); await gate; return { content: 'fixture' }; }
    } });
    const daemon = await startLocalDaemon(runtime, { port: 0 });
    const post = (path: string, body: unknown) => new Promise<{ status: number; retryAfter: string | undefined; body: any }>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, retryAfter: res.headers['retry-after'], body: JSON.parse(data) }));
        });
        req.setTimeout(5000, () => req.destroy(new Error('Fixture timeout')));
        req.on('error', reject); req.end(payload);
    });
    const input = { url: 'https://juejin.cn/post/1' };
    const pending = Array.from({ length: 4 }, () => post('/fetch-juejin', input));
    const finished = Promise.allSettled(pending);
    try {
        await allStarted;
        const overflow = await post('/fetch-juejin', input);
        assert.equal(overflow.status, 429);
        assert.equal(overflow.body.error.code, 'resource_limit');
        assert.equal(overflow.body.error.retryable, true);
        assert.equal(overflow.retryAfter, '1');
        assert.equal((await post('/search', { query: 'fixture', engines: Array(256).fill('bing'), limit: 1 })).status, 400);
    } finally {
        release();
        await finished;
        await daemon.close();
    }
    console.log('✅ real daemon returns 429/resource_limit/Retry-After and rejects amplified input');
}

async function testRealDownloadLimit(): Promise<void> {
    const upstream = http.createServer((_req, res) => res.end(Buffer.alloc(RESOURCE_LIMITS.maxResponseBytes + 1, 'a')));
    const listen = (server: http.Server) => new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    const upstreamPort = await listen(upstream);
    const sockets = new Set<import('node:stream').Duplex>();
    const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    proxy.on('connect', (_req, client, head) => {
        const target = net.connect(upstreamPort, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) target.write(head);
            client.pipe(target); target.pipe(client);
        });
        sockets.add(client); sockets.add(target);
        client.on('error', () => target.destroy()); target.on('error', () => client.destroy());
        client.on('close', () => { sockets.delete(client); target.destroy(); });
        target.on('close', () => sockets.delete(target));
    });
    const proxyPort = await listen(proxy);
    const old = { useProxy: config.useProxy, proxyUrl: config.proxyUrl };
    config.useProxy = true;
    config.proxyUrl = `http://127.0.0.1:${proxyPort}`;
    try {
        // A public literal passes URL validation; the audit-owned proxy sends
        // all bytes to our fixture. There are no Internet or private-service probes.
        await assert.rejects(requestWithSafeRedirects('GET', 'http://8.8.8.8/fixture', buildAxiosRequestOptions()), /maxContentLength|too large/i);
    } finally {
        Object.assign(config, old);
        for (const socket of sockets) socket.destroy();
        upstream.closeAllConnections(); proxy.closeAllConnections();
        await Promise.all([upstream, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
    console.log('✅ actual Axios download rejects bodies exceeding 2 MiB');
}

async function main(): Promise<void> {
    assert.deepEqual(parseMcpHttpOptions([], {}), { port: 3000, host: '0.0.0.0' });
    assert.deepEqual(parseMcpHttpOptions(['--local-only', '--port', '8080'], { PORT: '9000' }), { port: 8080, host: '127.0.0.1' });
    assert.deepEqual(parseMcpHttpOptions(['--port=8081'], { LOCAL_ONLY: 'true' }), { port: 8081, host: '127.0.0.1' });
    for (const port of ['0', '-1', '65536', '3.5', '3000oops', '']) {
        assert.throws(() => parseMcpHttpOptions(['--port=' + port], {}), /Port/);
    }
    assert.throws(() => parseMcpHttpOptions(['--port'], {}), /Missing/);
    assert.throws(() => parseMcpHttpOptions(['--local-only', '--bogus'], {}), /Unknown/);
    assert(shouldCreateFullRuntimeForInvocation(['--port', '8080', '--local-only']));
    assert(shouldCreateFullRuntimeForInvocation(['--local-only']));
    assert.equal(parseServeArgs(['--host', '0.0.0.0', '--local-only', '--port', '0']).host, '127.0.0.1');
    console.log('✅ MCP startup port/local-only validation and daemon local-only override');

    let now = 0;
    let expired = 0;
    const limiter = new SessionLimiter(2, 100, () => now);
    const first = limiter.acquire(() => expired++);
    const second = limiter.acquire(() => expired++);
    assert(first && second);
    assert.equal(limiter.acquire(() => expired++), null);
    now = 50;
    first.touch();
    now = 100;
    limiter.sweep();
    assert.equal(expired, 1);
    assert(limiter.acquire(() => expired++));
    first.release();
    first.release();
    assert(limiter.acquire(() => expired++));
    assert.equal(limiter.acquire(() => expired++), null, 'releasing one lease twice must not release another slot');
    now = 201;
    limiter.sweep();
    assert.equal(expired, 3);
    console.log('✅ session capacity, immediate reservations, idle refresh and idempotent release');

    let defaultNow = 0;
    let defaultExpired = 0;
    const defaultLimiter = new SessionLimiter(undefined, undefined, () => defaultNow);
    const defaultSessions = Array.from({ length: 4 }, () => defaultLimiter.acquire(() => defaultExpired++));
    assert(defaultSessions.every(Boolean));
    assert.equal(defaultLimiter.acquire(() => defaultExpired++), null, 'the fifth MCP session must be rejected');
    defaultNow = 3 * 60_000 - 1;
    defaultLimiter.sweep();
    assert.equal(defaultExpired, 0, 'sessions must remain available before the idle timeout');
    defaultNow++;
    defaultLimiter.sweep();
    assert.equal(defaultExpired, 4, 'all four idle sessions must expire at three minutes');
    assert(defaultLimiter.acquire(() => defaultExpired++), 'idle reclamation must free capacity');
    console.log('✅ default four-session quota and three-minute idle expiry boundary');

    let calls = 0;
    const service = createSearchService({
        bing: async () => { calls++; return []; },
        exa: async () => { calls++; return []; }
    });
    const result = await service.execute({ query: 'audit', engines: ['Bing', 'bing', 'exa'], limit: 1 });
    assert.deepEqual(result.engines, ['bing', 'exa']);
    assert.equal(calls, 1, 'duplicate engines and zero-result tasks must not execute');
    await assert.rejects(service.execute({ query: 'audit', engines: Array(256).fill('bing'), limit: 1 }), /engines must/);
    await assert.rejects(service.execute({ query: 'audit', engines: ['bing', 'exa', 'brave', 'csdn'], limit: 1 }), /at most 3/);
    await assert.rejects(service.execute({ query: 'a'.repeat(2049), engines: ['bing'], limit: 1 }), /Query must/);
    console.log('✅ engine deduplication, zero budget, input bounds');

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const busy = createSearchService({ bing: async () => { await gate; return []; } });
    const jobs = Array.from({ length: 4 }, () => busy.execute({ query: 'audit', engines: ['bing'], limit: 1 }));
    await assert.rejects(busy.execute({ query: 'audit', engines: ['bing'], limit: 1 }), { code: 'resource_limit' });
    release();
    await Promise.all(jobs);
    await busy.execute({ query: 'audit', engines: ['bing'], limit: 1 });

    let finishSlow!: () => void;
    const slow = new Promise<void>(resolve => { finishSlow = resolve; });
    const fatal = createSearchService({
        bing: async () => { throw Object.assign(new Error('browser missing'), { code: 'browser_unavailable' }); },
        exa: async () => { await slow; return []; }
    });
    const fatalJobs = Array.from({ length: 4 }, () => fatal.execute({ query: 'audit', engines: ['bing', 'exa'], limit: 2 }));
    const settled = Promise.allSettled(fatalJobs);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fatal.execute({ query: 'audit', engines: ['bing'], limit: 1 }), { code: 'resource_limit' });
    finishSlow();
    assert((await settled).every(job => job.status === 'rejected'));
    console.log('✅ concurrency cap and slot retention until all engines finish');

    let finishFetch!: () => void;
    const fetchGate = new Promise<void>(resolve => { finishFetch = resolve; });
    const article = createArticleFetchService('juejin', async () => { await fetchGate; return { content: 'fixture' }; });
    const fetchJobs = Array.from({ length: 4 }, () => article.execute({ url: 'https://juejin.cn/post/1' }));
    await assert.rejects(article.execute({ url: 'https://juejin.cn/post/1' }), { code: 'resource_limit' });
    finishFetch();
    await Promise.all(fetchJobs);
    await article.execute({ url: 'https://juejin.cn/post/1' });
    console.log('✅ shared fetch concurrency budget and release');

    const defaults = buildAxiosRequestOptions();
    assert.equal(defaults.timeout, 15000);
    assert.equal(defaults.maxContentLength, 2 * 1024 * 1024);
    assert.equal(defaults.maxBodyLength, 2 * 1024 * 1024);
    const capped = buildAxiosRequestOptions({ timeout: 30000, maxContentLength: -1, maxBodyLength: Infinity });
    assert.equal(capped.timeout, 15000);
    assert.equal(capped.maxContentLength, RESOURCE_LIMITS.maxResponseBytes);
    const smaller = buildAxiosRequestOptions({ timeout: 50, maxContentLength: 1024 });
    assert.equal(smaller.timeout, 50);
    assert.equal(smaller.maxContentLength, 1024);
    let signal: AbortSignal | undefined;
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8' }]);
    __setAxiosRequestForTests(async options => {
        signal = options.signal as AbortSignal;
        return new Promise(() => {});
    });
    try {
        await assert.rejects(requestWithSafeRedirects('GET', 'https://audit.example/', { timeout: 20 }), /timed out/);
        assert.equal(signal?.aborted, true, 'deadline must abort the underlying request');
        const canceled = new AbortController();
        canceled.abort();
        let canceledCalls = 0;
        __setAxiosRequestForTests(async () => { canceledCalls++; return new Promise(() => {}); });
        await assert.rejects(requestWithSafeRedirects('GET', 'https://audit.example/', { signal: canceled.signal }), /canceled/);
        assert.equal(canceledCalls, 0, 'an already canceled request must never reach Axios');
        __setDnsLookupForTests(async () => new Promise(() => {}));
        await assert.rejects(requestWithSafeRedirects('GET', 'https://audit.example/', { timeout: 20 }), /timed out/);
    } finally {
        __setAxiosRequestForTests();
        __setDnsLookupForTests();
    }
    console.log('✅ 15-second/2-MiB defaults, stricter budgets, HTTP and DNS deadline cancellation');
    await testRealDownloadLimit();
    await testDaemonCapacityResponse();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
