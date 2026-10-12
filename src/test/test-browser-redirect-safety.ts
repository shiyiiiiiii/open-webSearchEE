import { config } from '../config.js';
import { createControlledBrowserTask, type ControlledBrowserTask } from '../utils/browserNetworkPolicy.js';
import { fetchPageHtmlWithBrowser, getBrowserCookieHeader } from '../utils/browserCookies.js';
import { withPlaywrightPage } from '../utils/playwrightClient.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupTools } from '../tools/setupTools.js';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, request, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright-core';
import { installNavigationGuard } from '../utils/browserCookies.js';
import { __setDnsLookupForTests } from '../utils/urlSafety.js';

function port(server: Server): number {
    return (server.address() as AddressInfo).port;
}

async function listen(server: Server): Promise<void> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function run(): Promise<void> {
    process.env.OPEN_WEBSEARCH_PROFILE_DIR = `c03-test-browser-${process.pid}`;
    const bundledExecutablePath = (chromium as typeof chromium & { executablePath?: () => string }).executablePath?.();
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || [
        bundledExecutablePath,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    ].find(candidate => !!candidate && existsSync(candidate));
    if (!executablePath) {
        console.log('SKIP browser redirect integration: set PLAYWRIGHT_EXECUTABLE_PATH to a Chromium browser.');
        return;
    }

    // A local proxy simulates public origins without connecting to the internet.
    // If a private redirect escapes the real guard, the proxy forwards it only
    // to this test's loopback canary; checking the final URL alone fails here.
    const privateRequests: string[] = [];
    let privateConnections = 0;
    const canary = createServer((req, res) => {
        privateRequests.push(req.url || '');
        if (req.url === '/bounce') {
            res.writeHead(302, { location: 'http://1.1.1.1/final' });
        }
        res.end('LOOPBACK CANARY');
    });
    canary.on('connection', () => { privateConnections++; });
    await listen(canary);
    const canaryPort = port(canary);
    const redirectTargets = new Map([
        ['/to-loopback', `http://127.0.0.1:${canaryPort}/canary`],
        ['/to-localhost', `http://localhost:${canaryPort}/canary`],
        ['/to-integer', `http://2130706433:${canaryPort}/canary`],
        ['/to-ipv6', `http://[::1]:${canaryPort}/canary`],
        ['/to-mapped', `http://[::ffff:127.0.0.1]:${canaryPort}/canary`],
        ['/to-dns', `http://private-dns.example:${canaryPort}/canary`],
        ['/to-10', `http://10.1.2.3:${canaryPort}/canary`],
        ['/to-172', `http://172.0.1.2:${canaryPort}/canary`],
        ['/to-172-public', `http://172.64.1.2:${canaryPort}/canary`],
        ['/to-192', `http://192.1.2.3:${canaryPort}/canary`],
        ['/to-prefix-mapped', `http://[::ffff:192.1.2.3]:${canaryPort}/canary`],
        ['/to-prefix-dns', `http://blocked-prefix.example:${canaryPort}/canary`],
        ['/to-bounce', `http://127.0.0.1:${canaryPort}/bounce`],
        ['/via-public', 'http://1.1.1.1/to-loopback'],
        ['/public-redirect', 'http://1.1.1.1/final']
    ]);
    const privateHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '[::ffff:7f00:1]', 'private-dns.example',
        '10.1.2.3', '172.0.1.2', '172.64.1.2', '192.1.2.3', '[::ffff:c001:203]', 'blocked-prefix.example']);
    const publicRequests: string[] = [];
    let upstreamWebSockets = 0;
    const proxy = createServer((req, res) => {
        const target = new URL(req.url || '/', 'http://8.8.8.8');
        if (privateHosts.has(target.hostname) && target.port === String(canaryPort)) {
            const upstream = request({ hostname: '127.0.0.1', port: canaryPort, path: target.pathname }, response => {
                res.writeHead(response.statusCode || 200, response.headers);
                response.pipe(res);
            });
            upstream.on('error', () => res.destroy());
            upstream.end();
            return;
        }
        if (!['8.8.8.8', '1.1.1.1'].includes(target.hostname)) {
            res.writeHead(403);
            res.end();
            return;
        }
        publicRequests.push(target.toString());
        const location = redirectTargets.get(target.pathname);
        if (location) {
            res.writeHead(Number(target.searchParams.get('status')) || 302, { location });
            res.end();
            return;
        }
        if (target.pathname === '/service-worker.js') {
            res.writeHead(200, { 'content-type': 'application/javascript' });
            res.end('self.addEventListener("fetch", () => {});');
            return;
        }
        let extra = '';
        const privateUrl = `http://127.0.0.1:${canaryPort}/canary`;
        if (target.pathname === '/popup-open') extra = `<script>window.open('${privateUrl}')</script>`;
        if (target.pathname === '/popup-redirect') extra = `<script>window.open('http://1.1.1.1/to-loopback')</script>`;
        if (target.pathname === '/popup-blank') extra = `<script>const p=window.open('about:blank');if(p){try{p.location='${privateUrl}'}catch{}}</script>`;
        if (target.pathname === '/popup-anchor') extra = `<a id="open" href="${privateUrl}" target="_blank">open</a><script>document.getElementById('open').click()</script>`;
        if (target.pathname === '/popup-form') extra = `<form id="open" action="${privateUrl}" target="_blank"></form><script>document.getElementById('open').submit()</script>`;
        if (target.pathname === '/websockets') extra = `<script>for(const u of ['ws://127.0.0.1:${canaryPort}/ws','wss://127.0.0.1:${canaryPort}/wss','ws://8.8.8.8/ws']){try{new WebSocket(u)}catch{}}</script>`;
        if (target.pathname === '/with-frame') extra = '<iframe src="http://1.1.1.1/frame"></iframe>';
        if (target.pathname === '/frame-auto-navigation') extra = '<iframe src="http://1.1.1.1/frame" onload="setTimeout(()=>location.href=\'http://8.8.8.8/final\',50)"></iframe>';
        if (target.pathname === '/frame') extra = `<script>fetch('http://1.1.1.1/to-loopback').catch(()=>{});new WebSocket('ws://127.0.0.1:${canaryPort}/frame-ws');parent.postMessage('FRAME READY','*')</script><img src="http://1.1.1.1/to-loopback">`;
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'fixture=public; Path=/' });
        res.end(`<html><head><link rel="icon" href="data:,"></head><body>PUBLIC FINAL${
            target.pathname === '/with-image' ? '<img src="http://8.8.8.8/to-loopback">' : ''
        }${extra}</body></html>`);
    });
    proxy.on('upgrade', (_req, socket) => { upstreamWebSockets++; socket.destroy(); });
    proxy.on('connect', (req, socket) => {
        if (req.url?.endsWith(':' + canaryPort)) upstreamWebSockets++;
        socket.destroy();
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let browserServer: any;
    try {
        await listen(proxy);
        __setDnsLookupForTests(async hostname => {
            if (hostname === 'blocked-prefix.example') return [{ address: '192.1.2.3' }];
            assert.equal(hostname, 'private-dns.example', 'only the controlled DNS target may be resolved');
            return [{ address: '127.0.0.1' }];
        });
        browserServer = await (chromium as any).launchServer({ executablePath, headless: true, host: '127.0.0.1',
            // Fixture only: expose the secure-context Service Worker API on
            // this simulated public HTTP origin without trusting a test CA.
            args: ['--unsafely-treat-insecure-origin-as-secure=http://8.8.8.8']
        });
        browser = await chromium.connect({ wsEndpoint: browserServer.wsEndpoint() });
        console.log(JSON.stringify({ node: process.version, browser: browser.version(), playwright: createRequire(import.meta.url)('playwright-core/package.json').version }));
        config.playwrightWsEndpoint = browserServer.wsEndpoint();
        config.playwrightCdpEndpoint = undefined;
        config.browserEgressEnforced = true; // Test only the application layer against an unrestricted fixture proxy.
        config.browserEgressProxyUrl = 'http://127.0.0.1:' + port(proxy);
        config.browserAllowedPorts = [80, 443, canaryPort];
        const tasks = new Map<any, ControlledBrowserTask>();
        const context = { newPage: async () => {
            const task = await createControlledBrowserTask(browser);
            tasks.set(task.page, task);
            return task.page;
        } };
        const closeTask = async (page: any) => { await tasks.get(page)!.close(); tasks.delete(page); };
        for (const [path] of redirectTargets) {
            if (path === '/public-redirect') continue;
            const page = await context.newPage();
            try {
                await installNavigationGuard(page);
                await assert.rejects(
                    page.goto(`http://8.8.8.8${path}`, { timeout: 10000 }),
                    /ERR_BLOCKED_BY_CLIENT/,
                    `browser must abort before connecting to the private redirect: ${path}`
                );
                assert.equal(privateRequests.length, 0, `private service received a request via ${path}`);
                console.log(`✅ real browser blocks ${path} before the loopback service is contacted`);
            } finally {
                await closeTask(page);
            }
        }
        for (const status of [301, 303, 307, 308]) {
            const page = await context.newPage();
            try {
                await installNavigationGuard(page);
                await assert.rejects(page.goto(`http://8.8.8.8/to-loopback?status=${status}`, { timeout: 10000 }), /ERR_BLOCKED_BY_CLIENT/);
                assert.equal(privateRequests.length, 0);
            } finally {
                await closeTask(page);
            }
        }
        console.log('✅ real browser blocks loopback redirects for 301/302/303/307/308');

        for (const address of ['10.1.2.3', '172.64.1.2', '192.1.2.3']) {
            const directPage = await context.newPage();
            try {
                await installNavigationGuard(directPage);
                await assert.rejects(directPage.goto(`http://${address}:${canaryPort}/canary`, { timeout: 10000 }), /ERR_BLOCKED_BY_CLIENT/);
                assert.equal(privateRequests.length, 0, 'direct requests to blocked prefixes must also be stopped');
            } finally {
                await closeTask(directPage);
            }
        }
        console.log('✅ real browser blocks direct access to 10.*, 172.* and 192.*');

        const page = await context.newPage();
        await installNavigationGuard(page);
        await page.goto('http://8.8.8.8/public-redirect', { waitUntil: 'load', timeout: 10000 });
        assert.equal(page.url(), 'http://1.1.1.1/final', 'public redirects must preserve the final URL');
        assert((await page.content()).includes('PUBLIC FINAL'));
        await page.goto('http://8.8.8.8/with-image', { waitUntil: 'load', timeout: 10000 });
        assert(publicRequests.includes('http://8.8.8.8/to-loopback'), 'the redirected image must actually be requested');
        assert.equal(privateRequests.length, 0, 'image redirect must not contact the private service');
        console.log('✅ real browser permits public redirects and blocks private subresource redirects');
        await closeTask(page);

        const businessPage = await context.newPage();
        try {
            let businessRequests = 0;
            await businessPage.route('**/*', async (route: any) => { businessRequests++; await route.continue(); });
            await businessPage.goto('http://8.8.8.8/final');
            assert(businessRequests > 0, 'page business route must actually handle requests');
            await assert.rejects(businessPage.goto('http://8.8.8.8/to-loopback', { timeout: 10000 }), /ERR_BLOCKED_BY_CLIENT/);
            await assert.rejects(businessPage.goto(`http://127.0.0.1:${canaryPort}/canary`, { timeout: 10000 }), /ERR_BLOCKED_BY_CLIENT/);
            assert.equal(privateConnections, 0);
            assert.equal(privateRequests.length, 0);
        } finally { await closeTask(businessPage); }
        console.log('✅ independent CDP guard blocks private access when a page business route calls continue');

        for (const path of ['/popup-open', '/popup-redirect', '/popup-blank', '/popup-anchor', '/popup-form', '/websockets', '/with-frame']) {
            const page = await context.newPage();
            try {
                await page.goto('http://8.8.8.8' + path, { waitUntil: 'load', timeout: 10000 });
                await page.waitForTimeout(300);
                assert.equal(privateConnections, 0, `private service received a TCP connection: ${path}`);
                assert.equal(privateRequests.length, 0);
                assert.equal(upstreamWebSockets, 0);
                if (path.startsWith('/popup')) assert.equal(tasks.get(page)!.context.pages().length, 1, 'unexpected popups must be cleaned');
                if (path === '/with-frame') {
                    assert(tasks.get(page)!.diagnostics.guardedChildTargets > 0, 'OOPIF must receive its own guard before resuming');
                    const frame = page.frames().find((frame: any) => frame.url() === 'http://1.1.1.1/frame');
                    assert(frame, 'legitimate cross-site iframe must load');
                    assert((await frame.content()).includes('PUBLIC FINAL'));
                    assert(publicRequests.some(url => url === 'http://1.1.1.1/to-loopback'), 'iframe redirect probe must execute');
                }
            } finally { await closeTask(page); }
            console.log(`✅ ${path}: zero private TCP connections and zero WS upstream handshakes`);
        }
        for (const action of ['same-site', 'about-blank', 'remove', 'main-navigation', 'page-redirect']) {
            const task = await createControlledBrowserTask(browser);
            try {
                await task.run(async () => {
                    await task.page.goto('http://8.8.8.8/with-frame', { waitUntil: 'load' });
                    assert(task.diagnostics.guardedChildTargets > 0, 'lifecycle regression must exercise a guarded OOPIF');
                    if (action === 'main-navigation') await task.page.goto('http://8.8.8.8/final');
                    else if (action === 'page-redirect') {
                        await task.page.evaluate(() => { setTimeout(() => { location.href = 'http://8.8.8.8/final'; }, 10); });
                        await task.page.waitForURL('http://8.8.8.8/final');
                    } else {
                        await task.page.evaluate((action: string) => {
                            const frame = document.querySelector('iframe')!;
                            if (action === 'remove') frame.remove();
                            else frame.src = action === 'about-blank' ? 'about:blank' : 'http://8.8.8.8/final';
                        }, action);
                        if (action !== 'remove') {
                            const expected = action === 'about-blank' ? 'about:blank' : 'http://8.8.8.8/final';
                            for (let attempt = 0; attempt < 50 && !task.page.frames().some((frame: any) => frame.parentFrame() && frame.url() === expected); attempt++) {
                                await task.page.waitForTimeout(20);
                            }
                            assert(task.page.frames().some((frame: any) => frame.parentFrame() && frame.url() === expected));
                        }
                    }
                    await task.page.waitForTimeout(100);
                    assert((await task.page.content()).includes('PUBLIC FINAL'));
                });
                assert.equal(privateConnections, 0);
                console.log(`✅ OOPIF lifecycle ${action}: task remains usable with zero private connections`);
            } finally { await task.close(); }
        }
        const navigatedHtml = await fetchPageHtmlWithBrowser('http://8.8.8.8/frame-auto-navigation');
        assert.equal(navigatedHtml.finalUrl, 'http://8.8.8.8/final');
        assert(navigatedHtml.html.includes('PUBLIC FINAL'));
        console.log('✅ production HTML fetch survives main navigation after a cross-site iframe');

        let childGuard: { parent: any; sessionId: string } | undefined;
        const detached = await createControlledBrowserTask(browser, { prepareContext: async context => {
            const createSession = context.newCDPSession.bind(context);
            context.newCDPSession = async (page: any) => {
                const session = await createSession(page);
                session.on('Target.attachedToTarget', (event: any) => {
                    if (event.targetInfo.type === 'iframe') childGuard = { parent: session, sessionId: event.sessionId };
                });
                return session;
            };
        } });
        try {
            await assert.rejects(detached.run(async () => {
                await detached.page.goto('http://8.8.8.8/with-frame', { waitUntil: 'load' });
                assert(childGuard && detached.diagnostics.guardedChildTargets > 0, 'must detach the actual live child guard');
                await childGuard.parent.send('Target.detachFromTarget', { sessionId: childGuard.sessionId });
                await detached.page.waitForTimeout(3000);
            }), { code: 'browser_guard_lost' });
            await detached.close();
            assert(detached.page.isClosed());
            assert.equal(privateConnections, 0);
            assert.equal(privateRequests.length, 0);
            await assert.rejects(detached.page.goto(`http://127.0.0.1:${canaryPort}/canary`));
            assert.equal(privateConnections, 0);
            console.log('✅ actual live child CDP detach fails the task, closes the page and prevents later navigation');
        } finally { await detached.close(); }
        const workerPage = await context.newPage();
        try {
            await workerPage.goto('http://8.8.8.8/final');
            const serviceWorkerState = await workerPage.evaluate(async () => {
                if (!navigator.serviceWorker) throw Error('Service Worker API must be available for the probe');
                // Playwright's block option may resolve register() without a
                // registration rather than reject it. Check actual state.
                let registered = false;
                try { registered = !!await navigator.serviceWorker.register('/service-worker.js'); } catch { /* Blocked. */ }
                return { registered, registrations: (await navigator.serviceWorker.getRegistrations()).length,
                    controlled: !!navigator.serviceWorker.controller };
            });
            assert.deepEqual(serviceWorkerState, { registered: false, registrations: 0, controlled: false });
            assert(!publicRequests.includes('http://8.8.8.8/service-worker.js'), 'blocked registration must not fetch its worker script');
            const result = await workerPage.evaluate(() => {
                const outcome: string[] = [];
                for (const name of ['Worker', 'SharedWorker']) {
                    try { new (window as any)[name](URL.createObjectURL(new Blob(['fetch("http://127.0.0.1/")']))); }
                    catch { outcome.push(name); }
                }
                // Recover a constructor from a synchronously created realm.
                // The document CSP must still deny a blob worker.
                const frame = document.createElement('iframe');
                document.body.append(frame);
                try { new (frame.contentWindow as any).Worker(URL.createObjectURL(new Blob(['fetch("http://127.0.0.1/")']))); }
                catch { outcome.push('new-realm-worker'); }
                return outcome;
            });
            assert.deepEqual(result, ['Worker', 'SharedWorker', 'new-realm-worker']);
            assert.equal(privateConnections, 0);
            assert((await tasks.get(workerPage)!.context.cookies()).some((cookie: any) => cookie.name === 'fixture'));
        } finally { await closeTask(workerPage); }
        const cleanPage = await context.newPage();
        assert.equal((await tasks.get(cleanPage)!.context.cookies()).length, 0, 'new task must not inherit cookies');
        await closeTask(cleanPage);
        console.log('✅ Service Worker registration and cross-realm workers blocked; Cookie collection works and tasks isolate state');
        const html = await fetchPageHtmlWithBrowser('http://8.8.8.8/popup-open');
        assert(html.html.includes('PUBLIC FINAL'));
        assert((await getBrowserCookieHeader('http://8.8.8.8/final', true))?.includes('fixture=public'));
        const runtime = createOpenWebSearchRuntime();
        const mcp = new McpServer({ name: 'c03-browser-fixture', version: '1' });
        setupTools(mcp, runtime);
        const tool = (mcp as any)._registeredTools.fetchWebContent;
        const output = await tool.handler({ url: 'http://8.8.8.8/websockets', maxChars: 1000, renderMode: 'browser' });
        assert(!output.isError);
        assert(output.content[0].text.includes('PUBLIC FINAL'));
        await mcp.close();
        const daemon = await startLocalDaemon(runtime, { host: '127.0.0.1', port: 0 });
        try {
            const response = await fetch(daemon.baseUrl + '/fetch-web', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: 'http://8.8.8.8/popup-blank', maxChars: 1000, renderMode: 'browser' })
            });
            assert.equal(response.status, 200);
            assert((await response.text()).includes('PUBLIC FINAL'));
            const cancellation = new AbortController();
            const cancelled = fetch(daemon.baseUrl + '/fetch-web', {
                method: 'POST', headers: { 'content-type': 'application/json' }, signal: cancellation.signal,
                body: JSON.stringify({ url: 'http://8.8.8.8/cancel-client', maxChars: 1000, renderMode: 'browser' })
            });
            for (let attempt = 0; attempt < 50 && !publicRequests.includes('http://8.8.8.8/cancel-client'); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert(publicRequests.includes('http://8.8.8.8/cancel-client'), 'cancellation must occur after the browser actually navigates');
            cancellation.abort();
            await assert.rejects(cancelled);
            const inspector = await browser.newBrowserCDPSession();
            try {
                let active = true;
                for (let attempt = 0; attempt < 50 && active; attempt++) {
                    active = (await inspector.send('Target.getTargets')).targetInfos.some((target: any) => target.url === 'http://8.8.8.8/cancel-client');
                    if (active) await new Promise(resolve => setTimeout(resolve, 30));
                }
                assert(!active, 'client disconnect must destroy the browser target promptly');
            } finally { await inspector.detach(); }
        } finally { await daemon.close(); }
        assert.equal(privateConnections, 0);
        assert.equal(upstreamWebSockets, 0);
        console.log('✅ production HTML/Cookie/MCP tool/HTTP daemon entry points retain the guard');
        let enteredHostileEvaluation = false;
        await assert.rejects(withPlaywrightPage({ timeoutMs: 1000 }, async page => {
            await page.goto('http://8.8.8.8/final');
            page.on('console', (message: any) => { if (message.text() === 'HOSTILE EVALUATION STARTED') enteredHostileEvaluation = true; });
            await page.evaluate(() => { console.log('HOSTILE EVALUATION STARTED'); for (;;) { /* hostile page evaluation */ } });
        }), { code: 'browser_task_cancelled' });
        assert(enteredHostileEvaluation, 'the timeout test must actually enter the renderer loop');
        // Cleanup can take up to three seconds after cancellation.
        await new Promise(resolve => setTimeout(resolve, 100));
        await withPlaywrightPage({}, async page => { await page.goto('http://8.8.8.8/final'); });
        assert.equal(privateConnections, 0);
        console.log('✅ hostile evaluation is cancelled; subsequent task succeeds');
        console.log('\nBrowser redirect integration passed: zero requests to the loopback canary.');
    } finally {
        __setDnsLookupForTests();
        if (browser) await browser.close();
        if (browserServer) await browserServer.close();
        await Promise.all([close(proxy), close(canary)]);
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
