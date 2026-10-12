import { config } from '../config.js';
import { assertPublicHttpUrlResolved } from './urlSafety.js';
import { RESOURCE_LIMITS } from './resourceLimits.js';
import { EventEmitter } from 'node:events';

export class BrowserNetworkError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
}

export const BROWSER_NETWORK_ARGS = [
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-background-networking'
];

// This is an operator contract, not firewall discovery. The deployment must
// enforce it on the browser host (also for remote WS/CDP browsers).
export function getBrowserEgressProxy(): { server: string; bypass: string } {
    if (quarantinedConnections.has(connectionKey())) {
        throw new BrowserNetworkError('browser_worker_quarantined', 'Browser worker needs recycling after failed cleanup');
    }
    if (!config.browserEgressEnforced || !config.browserEgressProxyUrl) {
        throw new BrowserNetworkError('browser_egress_unverified',
            'Browser requires BROWSER_EGRESS_PROXY_URL and enforced egress on the browser host; see docs/security/browser-egress.zh-CN.md');
    }
    try {
        const url = new URL(config.browserEgressProxyUrl);
        if (url.protocol !== 'http:' || url.username || url.password ||
            url.pathname !== '/' || url.search || url.hash) throw new Error();
        return { server: url.origin, bypass: '<-loopback>' };
    } catch {
        throw new BrowserNetworkError('browser_egress_invalid', 'Browser egress must be an HTTP proxy origin without credentials');
    }
}

export async function validateBrowserNetworkUrl(input: string): Promise<void> {
    const url = new URL(input);
    if (url.username || url.password) {
        throw new BrowserNetworkError('browser_target_denied', 'Browser URL credentials are not allowed');
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!config.browserAllowedPorts.includes(port)) {
        throw new BrowserNetworkError('browser_target_denied', 'Browser target port is not allowed');
    }
    await assertPublicHttpUrlResolved(url, 'Browser request URL');
}

export async function boundedBrowserCleanup(operation: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation.then(() => true, () => false),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3000); })
        ]);
    } finally { clearTimeout(timer); }
}

const quarantinedBrowsers = new WeakSet<object>();
const quarantinedConnections = new Set<string>();
function connectionKey(): string {
    return config.playwrightWsEndpoint || config.playwrightCdpEndpoint || `local:${config.playwrightExecutablePath || 'auto'}`;
}
export function isBrowserQuarantined(browser: object): boolean { return quarantinedBrowsers.has(browser); }

type ContextState = {
    ready: boolean;
    closing: boolean;
    page?: any;
    context: any;
    guards: WeakMap<object, Promise<void>>;
    fail(error: BrowserNetworkError): void;
    diagnostics: { blockedRequests: number; blockedWebSockets: number; guardedChildTargets: number };
};
const controlledContexts = new WeakMap<object, ContextState>();

// Non-flattened child sessions stay on this task's CDP connection. They do not
// change Playwright's own auto-attach configuration or attach other contexts.
function relayChildSession(parent: any, sessionId: string) {
    const child: any = new EventEmitter();
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    let nextId = 0;
    child.send = (method: string, params: any = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        void parent.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
            .catch(() => { pending.delete(id); reject(new Error('Child interception disconnected')); });
    });
    child.receive = (message: string) => {
        const event = JSON.parse(message);
        if (event.id) {
            const command = pending.get(event.id);
            pending.delete(event.id);
            if (event.error) command?.reject(new Error('Child interception command failed'));
            else command?.resolve(event.result);
        } else child.emit(event.method, event.params);
    };
    child.disconnected = () => {
        for (const command of pending.values()) command.reject(new Error('Child interception disconnected'));
        pending.clear();
    };
    return child;
}

async function readTargetDocument(session: any): Promise<{ frameId: string; loaderId: string }> {
    const { frameTree } = await session.send('Page.getFrameTree');
    const frame = frameTree?.frame;
    if (typeof frame?.id !== 'string' || !frame.id || typeof frame.loaderId !== 'string') {
        throw new Error('Browser document identity is unavailable');
    }
    return { frameId: frame.id, loaderId: frame.loaderId };
}

async function configureTargetGuard(session: any, state: ContextState): Promise<void> {
    type ChildGuard = { session: any; targetId: string; parentLoaderId: string; removed: boolean; detached: boolean };
    const children = new Map<string, ChildGuard>();
    let ownerFrameId: string;
    let loaderId: string;
    session.on('Page.frameNavigated', (event: any) => {
        if (event.frame.id === ownerFrameId) loaderId = event.frame.loaderId;
    });
    session.on('Page.frameDetached', (event: any) => {
        // "swap" only changes the renderer hosting a frame; it does not
        // remove that frame from the document or excuse a lost guard.
        if (event.reason !== 'remove') return;
        for (const child of children.values()) {
            if (child.targetId === event.frameId) child.removed = true;
        }
    });
    await session.send('Page.enable');
    const document = await readTargetDocument(session);
    ownerFrameId = document.frameId;
    loaderId = document.loaderId;
    session.on('Target.receivedMessageFromTarget', (event: any) => {
        try { children.get(event.sessionId)?.session.receive(event.message); }
        catch { state.fail(new BrowserNetworkError('browser_guard_lost', 'Browser child interception failed')); }
    });
    session.on('Target.attachedToTarget', (event: any) => {
        let childGuard: ChildGuard | undefined;
        void (async () => {
            if (event.targetInfo.type !== 'iframe') {
                // Workers are unnecessary for document extraction. Close them
                // while paused, including constructors recovered from a realm.
                await session.send('Target.closeTarget', { targetId: event.targetInfo.targetId });
                return;
            }
            const child = relayChildSession(session, event.sessionId);
            childGuard = { session: child, targetId: event.targetInfo.targetId, parentLoaderId: loaderId, removed: false, detached: false };
            children.set(event.sessionId, childGuard);
            await configureTargetGuard(child, state);
            state.diagnostics.guardedChildTargets++;
            await child.send('Runtime.runIfWaitingForDebugger');
        })().catch(() => {
            // Detach verification owns this failure once the session has
            // gone away, including a normal navigation during installation.
            if (!state.closing && !childGuard?.detached) state.fail(new BrowserNetworkError('browser_guard_lost', 'Browser child interception could not be installed'));
        });
    });
    session.on('Target.detachedFromTarget', (event: any) => {
        const child = children.get(event.sessionId);
        if (!child) return;
        child.detached = true;
        child.session.disconnected();
        if (state.closing) { children.delete(event.sessionId); return; }
        void (async () => {
            // A target may briefly survive its document's navigation. Keep
            // the record until verification so frame removal events arriving
            // after Target.detachedFromTarget can still retire it.
            try { await session.send('Target.getTargetInfo', { targetId: child.targetId }); }
            catch { return; } // Destroyed targets cannot continue unguarded.
            const current = await readTargetDocument(session);
            if (current.frameId !== ownerFrameId) throw new Error();
            if (!state.closing && !child.removed && current.loaderId === child.parentLoaderId) {
                state.fail(new BrowserNetworkError('browser_guard_lost', 'Browser child interception detached'));
            }
        })().catch(() => {
            if (!state.closing) state.fail(new BrowserNetworkError('browser_guard_lost', 'Browser child lifecycle could not be verified'));
        }).finally(() => children.delete(event.sessionId));
    });
    session.on('Fetch.requestPaused', (event: any) => {
        void (async () => {
            try {
                if (!state.ready || state.closing) throw new Error();
                await validateBrowserNetworkUrl(event.request.url);
                if (!state.ready || state.closing) throw new Error();
            } catch {
                state.diagnostics.blockedRequests++;
                try { await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); }
                catch { if (!state.closing) state.fail(new BrowserNetworkError('browser_guard_lost', 'Browser request interception failed')); }
                return;
            }
            try {
                if (event.responseStatusCode !== undefined) {
                    // Browser-enforced CSP also covers blob/data workers and
                    // newly created realms. No body fetch/replay or TLS bypass.
                    await session.send('Fetch.continueResponse', {
                        requestId: event.requestId, responseCode: event.responseStatusCode,
                        responseHeaders: [...(event.responseHeaders || []), {
                            name: 'Content-Security-Policy', value: "worker-src 'none'; connect-src http: https: data: blob:; object-src 'none'"
                        }]
                    });
                } else await session.send('Fetch.continueRequest', { requestId: event.requestId });
            } catch { if (!state.closing) state.fail(new BrowserNetworkError('browser_guard_lost', 'Browser request interception failed')); }
        })();
    });
    await session.send('Fetch.enable', { patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }
    ] });
    await session.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: false,
        filter: [{ type: 'iframe' }, { type: 'worker' }, { type: 'shared_worker' }, { exclude: true }]
    });
}

// There is no page-level HTTP route here: page.route().continue() would bypass
// the context handler. CDP independently checks every redirect hop.
export function installBrowserPageGuard(page: any): Promise<void> {
    const context = page.context?.();
    const state = controlledContexts.get(context);
    if (!state || state.page !== page || state.closing) {
        return Promise.reject(new BrowserNetworkError('browser_guard_unavailable', 'Page does not belong to a controlled browser task'));
    }
    const previous = state.guards.get(page);
    if (previous) return previous;
    const guard = (async () => {
        if (typeof context.newCDPSession !== 'function') throw new Error();
        // Older dynamically loaded clients may accept an unknown event name
        // without ever emitting it. Verify detach notification, not a version
        // string, before trusting the required runtime failure listener.
        const probe = await context.newCDPSession(page);
        let notified = false;
        probe.on('close', () => { notified = true; });
        if (!await boundedBrowserCleanup(probe.detach())) throw new Error();
        await new Promise(resolve => setImmediate(resolve));
        if (!notified) throw new Error();
        const session = await context.newCDPSession(page);
        session.on('close', () => {
            if (!state.closing) state.fail(new BrowserNetworkError(state.ready ? 'browser_guard_lost' : 'browser_guard_unavailable', 'Browser redirect interception disconnected'));
        });
        try {
            await configureTargetGuard(session, state);
        } catch {
            await boundedBrowserCleanup(session.detach());
            throw new Error();
        }
    })().catch(() => {
        const error = new BrowserNetworkError('browser_guard_unavailable', 'Browser redirect interception could not be installed');
        state.fail(error);
        throw error;
    });
    state.guards.set(page, guard);
    return guard;
}

export type ControlledBrowserTask = {
    context: any;
    page: any;
    run<T>(operation: () => Promise<T>): Promise<T>;
    close(): Promise<void>;
    diagnostics: ContextState['diagnostics'];
};

export async function createControlledBrowserTask(browser: any, options: {
    contextOptions?: any;
    prepareContext?: (context: any) => Promise<void>;
    preparePage?: (page: any) => Promise<void>;
    signal?: AbortSignal;
    onCleanupFailure?: () => void;
} = {}): Promise<ControlledBrowserTask> {
    const proxy = getBrowserEgressProxy();
    const key = connectionKey();
    if (quarantinedConnections.has(key)) throw new BrowserNetworkError('browser_worker_quarantined', 'Browser worker needs recycling after failed cleanup');
    if (quarantinedBrowsers.has(browser) || browser.isConnected?.() === false) {
        throw new BrowserNetworkError('browser_guard_lost', 'Browser connection is unavailable');
    }
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    // Failure can arrive before a caller starts run().
    void failure.catch(() => undefined);
    let context: any;
    let closePromise: Promise<void> | undefined;
    let state: ContextState | undefined;
    let failed: Error | undefined;
    const closeContext = async (created: any): Promise<void> => {
        if (await boundedBrowserCleanup(Promise.resolve().then(() => created.close()))) return;
        quarantinedBrowsers.add(browser);
        quarantinedConnections.add(key);
        try { options.onCleanupFailure?.(); } catch { /* Quarantine remains mandatory even if notification fails. */ }
    };
    const close = (): Promise<void> => closePromise ??= (async () => {
        if (state) { state.closing = true; state.ready = false; }
        options.signal?.removeEventListener('abort', onAbort);
        clearTimeout(deadline);
        browser.off?.('disconnected', onDisconnect);
        if (context) await closeContext(context);
    })();
    const fail = (error: BrowserNetworkError) => {
        if (failed || state?.closing) return;
        failed = error;
        rejectFailure(error);
        void close();
    };
    const onAbort = () => fail(new BrowserNetworkError('browser_task_cancelled', 'Browser task was cancelled or exceeded its deadline'));
    const onDisconnect = () => fail(new BrowserNetworkError('browser_guard_lost', 'Browser disconnected during task'));
    const deadline = setTimeout(onAbort, RESOURCE_LIMITS.requestTimeoutMs);
    const run = async <T>(operation: () => Promise<T>): Promise<T> => {
        if (failed) throw failed;
        return Promise.race([Promise.resolve().then(operation), failure]);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    browser.on?.('disconnected', onDisconnect);
    try {
        if (options.signal?.aborted) { onAbort(); throw failed; }
        // Always own the context; never recover through contexts()[0]/newPage().
        const creating = Promise.resolve().then(() => browser.newContext({
            ...options.contextOptions, proxy, serviceWorkers: 'block', acceptDownloads: false,
            bypassCSP: false, ignoreHTTPSErrors: false
        }));
        void creating.then(async created => {
            if (failed) await closeContext(created);
        }, () => undefined);
        context = await run(() => creating);
        state = { ready: false, closing: false, context, guards: new WeakMap(), fail,
            diagnostics: { blockedRequests: 0, blockedWebSockets: 0, guardedChildTargets: 0 } };
        controlledContexts.set(context, state);
        for (const method of ['route', 'routeWebSocket', 'newPage', 'newCDPSession', 'addInitScript', 'on', 'close']) {
            if (typeof context[method] !== 'function') throw new Error();
        }
        context.on('close', () => { if (!state!.closing) fail(new BrowserNetworkError('browser_guard_lost', 'Browser context closed unexpectedly')); });
        let creatingRootPage = false;
        context.on('page', (page: any) => {
            if (creatingRootPage && !state!.page) state!.page = page;
            else if (page !== state!.page) void page.close().catch(() => undefined);
        });
        await run(() => context.route('**/*', async (route: any) => {
            try {
                if (!state!.ready || state!.closing) throw new Error();
                const request = route.request();
                // frame() throws for worker and early popup requests: deny.
                if (request.frame().page() !== state!.page) throw new Error();
                const destination = request.headers()['sec-fetch-dest'];
                if (destination === 'worker' || destination === 'sharedworker' || destination === 'serviceworker') throw new Error();
                await validateBrowserNetworkUrl(request.url());
                if (!state!.ready || state!.closing) throw new Error();
                await route.continue();
            } catch {
                state!.diagnostics.blockedRequests++;
                await route.abort('blockedbyclient').catch(() => undefined);
            }
        }));
        await run(() => context.routeWebSocket('**/*', (socket: any) => {
            state!.diagnostics.blockedWebSockets++;
            // Never call connectToServer(), even while asynchronous checks run.
            void Promise.resolve().then(() => socket.close({ code: 1008, reason: 'Browser network policy' }))
                .catch(() => fail(new BrowserNetworkError('browser_guard_lost', 'Browser WebSocket interception failed')));
        }));
        // Disable unnecessary constructors in each document/iframe as defence
        // in depth. Unknown worker traffic is denied above; actual IP access is
        // constrained by the mandatory egress proxy and host network policy.
        await run(() => context.addInitScript(() => {
            const denied = function () { throw new DOMException('Disabled by browser network policy', 'SecurityError'); };
            for (const name of ['Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
                Object.defineProperty(globalThis, name, { value: denied, configurable: false, writable: false });
            }
        }));
        if (options.prepareContext) await run(() => options.prepareContext!(context));
        creatingRootPage = true;
        const page: any = await run<any>(() => context.newPage());
        creatingRootPage = false;
        state.page = page;
        page.on('crash', () => fail(new BrowserNetworkError('browser_guard_lost', 'Browser page crashed')));
        page.on('close', () => { if (!state!.closing) fail(new BrowserNetworkError('browser_guard_lost', 'Browser page closed unexpectedly')); });
        await run(() => installBrowserPageGuard(page));
        if (options.preparePage) await run(() => options.preparePage!(page));
        if (failed || state.closing) throw failed;
        state.ready = true;
        return { context, page, run, close, diagnostics: state.diagnostics };
    } catch (error) {
        await close();
        if (error instanceof BrowserNetworkError) throw error;
        throw new BrowserNetworkError('browser_guard_unavailable', 'Controlled browser context could not be initialised');
    }
}

// Includes connection and context initialisation. On timeout the abort signal
// actively closes the task context; late acquisitions are disposed by callers.
export async function withBrowserDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, options: {
    signal?: AbortSignal;
    timeoutMs?: number;
} = {}): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, options.timeoutMs ?? RESOURCE_LIMITS.requestTimeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
        return await Promise.race([
            operation(controller.signal),
            new Promise<never>((_, reject) => {
                const aborted = () => reject(new BrowserNetworkError('browser_task_cancelled', 'Browser task was cancelled or exceeded its deadline'));
                if (controller.signal.aborted) aborted();
                else controller.signal.addEventListener('abort', aborted, { once: true });
            })
        ]);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        controller.abort();
    }
}
