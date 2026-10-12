import { EventEmitter } from 'node:events';

export function makeControlledBrowserMock(options: { missing?: string; fail?: string; blockedClose?: boolean } = {}) {
    const browser: any = new EventEmitter();
    const calls: string[] = [];
    const contexts: any[] = [];
    let nextId = 0;
    browser.isConnected = () => true;
    browser.contexts = () => { throw new Error('Must not access existing contexts'); };
    browser.newContext = async (contextOptions: any) => {
        calls.push('newContext');
        if (options.fail === 'newContext') throw new Error('fixture error');
        const context: any = new EventEmitter();
        context.options = contextOptions;
        context.closed = false;
        context.sessions = [];
        context.pages = () => context.page ? [context.page] : [];
        context.cookies = async () => [{ name: 'test-cookie', value: 'fixture' }];
        for (const method of ['route', 'routeWebSocket', 'addInitScript']) {
            context[method] = async (_pattern: any, handler: any) => {
                calls.push(method);
                if (options.fail === method) throw new Error('fixture error');
                context[method + 'Handler'] = handler;
            };
        }
        context.newPage = async () => {
            calls.push('newPage');
            if (options.fail === 'newPage') throw new Error('fixture error');
            const page: any = new EventEmitter();
            page._targetId = 'controlled-' + ++nextId;
            page.context = () => context;
            page.url = () => 'about:blank';
            page.isClosed = () => context.closed;
            page.close = async () => { page.emit('close'); };
            context.page = page;
            context.emit('page', page);
            return page;
        };
        context.newCDPSession = async () => {
            calls.push('newCDPSession');
            const session: any = new EventEmitter();
            session.send = async (method: string, params?: any) => {
                calls.push(method);
                if (options.fail === method) throw new Error('fixture error');
                session.lastCommand = { method, params };
                if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: context.page._targetId } };
                if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: context.page._targetId, loaderId: 'fixture-document' } } };
            };
            session.detach = async () => { session.emit('close'); };
            context.sessions.push(session);
            return session;
        };
        context.close = async () => {
            calls.push('close');
            if (options.blockedClose) return new Promise(() => undefined);
            context.closed = true;
            context.page?.emit('close');
            for (const session of context.sessions) session.emit('close');
            context.emit('close');
        };
        if (options.missing) delete context[options.missing];
        contexts.push(context);
        return context;
    };
    return { browser, calls, contexts };
}
