import assert from 'node:assert/strict';
import { config } from '../config.js';
import { __setDnsLookupForTests } from '../utils/urlSafety.js';
import { createControlledBrowserTask, getBrowserEgressProxy, installBrowserPageGuard, isBrowserQuarantined, validateBrowserNetworkUrl, withBrowserDeadline } from '../utils/browserNetworkPolicy.js';
import { makeControlledBrowserMock } from './helpers/controlledBrowserMock.js';

async function run() {
    config.browserEgressEnforced = false;
    assert.throws(getBrowserEgressProxy, { code: 'browser_egress_unverified' });
    config.browserEgressEnforced = true;
    config.browserEgressProxyUrl = 'http://127.0.0.1:3128';
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34' }]);
    for (const input of ['http://user:secret@example.test', 'https://example.test:22', 'file:///etc/passwd']) {
        await assert.rejects(validateBrowserNetworkUrl(input));
    }
    const fixture = makeControlledBrowserMock();
    const task = await createControlledBrowserTask(fixture.browser);
    assert.equal(task.context.options.serviceWorkers, 'block');
    assert.equal(task.context.options.proxy.bypass, '<-loopback>');
    assert(fixture.calls.indexOf('route') < fixture.calls.indexOf('newPage'));
    assert(fixture.calls.indexOf('routeWebSocket') < fixture.calls.indexOf('newPage'));
    await Promise.all([installBrowserPageGuard(task.page), installBrowserPageGuard(task.page)]);
    assert.equal(fixture.calls.filter(call => call === 'Fetch.enable').length, 1);
    const check = async (url: string, frame: () => any, destination = '') => {
        let outcome = '';
        await task.context.routeHandler({
            request: () => ({ url: () => url, frame, headers: () => ({ 'sec-fetch-dest': destination }) }),
            continue: async () => { outcome = 'continue'; }, abort: async () => { outcome = 'abort'; }
        });
        return outcome;
    };
    const ownFrame = () => ({ page: () => task.page });
    assert.equal(await check('https://example.test', ownFrame), 'continue');
    assert.equal(await check('http://127.0.0.1', ownFrame), 'abort');
    assert.equal(await check('https://example.test', () => ({ page: () => ({}) })), 'abort', 'popup to even a public target is denied');
    assert.equal(await check('https://example.test', () => { throw Error(); }), 'abort', 'early frame/worker is denied');
    assert.equal(await check('https://example.test/worker.js', ownFrame, 'worker'), 'abort');
    let wsClosed = false;
    task.context.routeWebSocketHandler({ close: async () => { wsClosed = true; }, connectToServer: () => { throw Error('Must not connect'); } });
    await new Promise(resolve => setImmediate(resolve));
    assert(wsClosed);
    const pending = task.run(() => new Promise(() => undefined));
    task.context.sessions.at(-1).emit('close');
    await assert.rejects(pending, { code: 'browser_guard_lost' });
    await task.close();
    assert(task.context.closed);
    assert.equal(fixture.browser.listenerCount('disconnected'), 0);
    console.log('PASS: ready ordering, HTTP ownership, unknown frames/workers, WS denial and CDP detach');

    const reconnecting = makeControlledBrowserMock();
    const disconnectedTask = await createControlledBrowserTask(reconnecting.browser);
    const interrupted = disconnectedTask.run(() => new Promise(() => undefined));
    reconnecting.browser.emit('disconnected');
    await assert.rejects(interrupted, { code: 'browser_guard_lost' });
    await disconnectedTask.close();
    assert(disconnectedTask.context.closed);
    const nextTask = await createControlledBrowserTask(reconnecting.browser);
    assert.notEqual(nextTask.context, disconnectedTask.context);
    assert.equal(reconnecting.calls.filter(call => call === 'Fetch.enable').length, 2);
    await nextTask.close();
    console.log('PASS: disconnection closes the task; subsequent acquisition installs fresh guards');

    for (const scenario of ['removed-late', 'parent-navigated', 'active', 'swap', 'verification-failed', 'missing-document-identity', 'destroyed']) {
        const lifecycle = makeControlledBrowserMock();
        const handle = await createControlledBrowserTask(lifecycle.browser);
        try {
            const parent = handle.context.sessions.at(-1);
            const originalSend = parent.send;
            let parentLoaderId = 'fixture-document';
            parent.send = async (method: string, params: any) => {
                if (method === 'Target.sendMessageToTarget') {
                    const command = JSON.parse(params.message);
                    const result = command.method === 'Page.getFrameTree'
                        ? { frameTree: { frame: { id: 'child-frame', loaderId: 'child-document' } } } : {};
                    queueMicrotask(() => parent.emit('Target.receivedMessageFromTarget', {
                        sessionId: params.sessionId, message: JSON.stringify({ id: command.id, result })
                    }));
                    return;
                }
                if (method === 'Page.getFrameTree') {
                    if (scenario === 'verification-failed') throw Error('Cannot verify document');
                    if (scenario === 'missing-document-identity') return { frameTree: { frame: { id: handle.page._targetId } } };
                    return { frameTree: { frame: { id: handle.page._targetId, loaderId: parentLoaderId } } };
                }
                if (method === 'Target.getTargetInfo' && scenario === 'destroyed') throw Error('Target no longer exists');
                return originalSend(method, params);
            };
            parent.emit('Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child-frame' } });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(handle.diagnostics.guardedChildTargets, 1, 'child must finish installing its guard');
            parent.emit('Target.detachedFromTarget', { sessionId: 'child-session' });
            // These events deliberately follow Target.detachedFromTarget.
            if (scenario === 'removed-late' || scenario === 'swap') {
                parent.emit('Page.frameDetached', { frameId: 'child-frame', reason: scenario === 'swap' ? 'swap' : 'remove' });
            }
            if (scenario === 'parent-navigated') parentLoaderId = 'next-document';
            const outcome = handle.run(async () => { await new Promise(resolve => setImmediate(resolve)); return 'usable'; });
            if (['active', 'swap', 'verification-failed', 'missing-document-identity'].includes(scenario)) {
                await assert.rejects(outcome, { code: 'browser_guard_lost' });
                await handle.close();
                assert(handle.context.closed, 'a live child losing its guard must close the entire context');
                let continued = false;
                await handle.context.routeHandler({
                    request: () => ({ url: () => 'https://example.test', frame: () => ({ page: () => handle.page }), headers: () => ({}) }),
                    continue: async () => { continued = true; }, abort: async () => undefined
                });
                assert(!continued, 'no later HTTP request may continue after guard loss');
            } else assert.equal(await outcome, 'usable', `normal lifecycle must preserve the task: ${scenario}`);
        } finally { await handle.close(); }
    }
    console.log('PASS: late frame removal and parent navigation retire children; live detach, swap and unverifiable lifecycle fail closed');

    for (const method of ['route', 'routeWebSocket', 'newCDPSession', 'addInitScript']) {
        const unavailable = makeControlledBrowserMock({ missing: method });
        await assert.rejects(createControlledBrowserTask(unavailable.browser), { code: 'browser_guard_unavailable' });
        assert(!unavailable.calls.includes('newPage'));
        assert(unavailable.contexts[0].closed);
    }
    for (const method of ['newContext', 'route', 'routeWebSocket', 'addInitScript', 'newPage', 'Page.enable', 'Page.getFrameTree', 'Fetch.enable']) {
        const broken = makeControlledBrowserMock({ fail: method });
        await assert.rejects(createControlledBrowserTask(broken.browser), { code: 'browser_guard_unavailable' });
        assert(broken.contexts.every(context => context.closed));
    }
    console.log('PASS: missing APIs and every initialisation failure close resources without default-context fallback');

    const cancelled = makeControlledBrowserMock();
    await assert.rejects(withBrowserDeadline(async signal => {
        const handle = await createControlledBrowserTask(cancelled.browser, { signal });
        try { return await handle.run(() => new Promise(() => undefined)); }
        finally { await handle.close(); }
    }, { timeoutMs: 30 }), { code: 'browser_task_cancelled' });
    await new Promise(resolve => setImmediate(resolve));
    assert(cancelled.contexts[0].closed);

    // A remote newContext response may arrive after cancellation. It still
    // belongs to this task; a failed late cleanup must quarantine the endpoint.
    const previousEndpoint = config.playwrightWsEndpoint;
    try {
        for (const cleanupFails of [false, true]) {
            config.playwrightWsEndpoint = `ws://late-context-${cleanupFails}.test/browser`;
            const late = makeControlledBrowserMock();
            const originalCreate = late.browser.newContext;
            let finishCreation!: () => Promise<void>;
            late.browser.newContext = (options: any) => new Promise(resolve => {
                finishCreation = async () => {
                    const context = await originalCreate(options);
                    if (cleanupFails) context.close = async () => { throw Error('late cleanup failed'); };
                    resolve(context);
                };
            });
            const controller = new AbortController();
            const creating = createControlledBrowserTask(late.browser, { signal: controller.signal });
            await new Promise(resolve => setImmediate(resolve));
            controller.abort();
            await assert.rejects(creating, { code: 'browser_task_cancelled' });
            await finishCreation();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(late.contexts[0].closed, !cleanupFails);
            assert.equal(isBrowserQuarantined(late.browser), cleanupFails);
            if (cleanupFails) assert.throws(getBrowserEgressProxy, { code: 'browser_worker_quarantined' });
        }
    } finally { config.playwrightWsEndpoint = previousEndpoint; }
    const quarantined = makeControlledBrowserMock({ blockedClose: true });
    const bad = await createControlledBrowserTask(quarantined.browser);
    await bad.close();
    assert(isBrowserQuarantined(quarantined.browser));
    await assert.rejects(createControlledBrowserTask(quarantined.browser), { code: 'browser_worker_quarantined' });
    __setDnsLookupForTests();
    console.log('PASS: deadline actively closes context; failed cleanup quarantines the connection');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
