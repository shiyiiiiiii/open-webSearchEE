import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { config } from '../config.js';
import { resolvePublicHttpAddresses } from './urlSafety.js';
import { RESOURCE_LIMITS } from './resourceLimits.js';
import { Resolver } from 'node:dns/promises';
import type { DnsLookupFn } from './urlSafety.js';

export type BrowserEgressDecision = {
    allowed: boolean;
    hostname: string;
    port: number;
    addresses: string[];
    answerCount: number;
    selectedAddress?: string;
};

function forwardedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
    const result = { ...headers };
    const connectionHeaders = String(result.connection || '').split(',').map(value => value.trim().toLowerCase());
    for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
        'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...connectionHeaders]) delete result[name];
    return result;
}

export function createBrowserEgressProxy(transports: { request?: typeof request; connect?: typeof connect; lookup?: DnsLookupFn } = {}) {
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    // Fixed controlled DNS, never the browser's resolver or synthetic DNS.
    resolver.setServers(['1.1.1.1']);
    const lookup: DnsLookupFn = transports.lookup ?? (async hostname => {
        const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
        const addresses: Array<{ address: string }> = [];
        for (const answer of answers) {
            if (answer.status === 'fulfilled') addresses.push(...answer.value.map(address => ({ address })));
            else if (!['ENODATA', 'ENOTFOUND'].includes(answer.reason?.code)) throw new Error('DNS failed');
        }
        return addresses;
    });
    const sockets = new Set<Socket>();
    const deny = (res: ServerResponse) => {
        if (!res.headersSent) res.writeHead(403, { connection: 'close' });
        res.end('Browser egress denied');
    };
    const resolve = async (url: URL) => {
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        let answers = [url.hostname.replace(/^\[|\]$/g, '')].filter(address => isIP(address) !== 0);
        const audit = (allowed: boolean, selectedAddress?: string) => {
            const decision: BrowserEgressDecision = {
                allowed, hostname: url.hostname.slice(0, 253), port,
                addresses: answers.slice(0, 16), answerCount: answers.length, selectedAddress
            };
            // Never include URL paths, queries, credentials or raw errors.
            server.emit('egressDecision', decision);
        };
        try {
            if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error();
            if (!config.browserAllowedPorts.includes(port)) throw new Error();
            // No FAKE_IP_CIDRS exception at the connection boundary. All
            // answers must pass; net receives only this validated numeric IP.
            const addresses = await resolvePublicHttpAddresses(url, 'Browser egress target', false, async hostname => {
                const resolved = await lookup(hostname);
                answers = resolved.map(entry => entry.address).filter(address => isIP(address) !== 0);
                return resolved;
            });
            audit(true, addresses[0].address);
            return { ...addresses[0], port };
        } catch {
            audit(false);
            throw new Error('Browser egress target denied');
        }
    };
    const server = createServer(async (req, res) => {
        let upstream: ReturnType<typeof request> | undefined;
        const timer = setTimeout(() => { upstream?.destroy(); req.destroy(); res.destroy(); }, RESOURCE_LIMITS.requestTimeoutMs);
        res.once('close', () => { clearTimeout(timer); upstream?.destroy(); });
        try {
            // Reject origin-form paths: this service is only a forward proxy.
            if (!req.url?.startsWith('http://') || req.headers.upgrade) throw new Error();
            const url = new URL(req.url);
            const destination = await resolve(url);
            if (req.destroyed || res.destroyed) return;
            const headers = forwardedHeaders(req.headers);
            headers.host = url.host;
            upstream = (transports.request ?? request)({
                hostname: destination.address, family: destination.family, port: destination.port,
                method: req.method, path: url.pathname + url.search, headers, agent: false
            }, response => {
                if (Number(response.headers['content-length'] || 0) > RESOURCE_LIMITS.maxResponseBytes) {
                    response.destroy(); deny(res); return;
                }
                res.writeHead(response.statusCode || 502, forwardedHeaders(response.headers));
                let bytes = 0;
                response.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > RESOURCE_LIMITS.maxResponseBytes) { response.destroy(); res.destroy(); }
                });
                response.on('error', () => res.destroy());
                response.pipe(res);
            });
            upstream.on('error', () => { if (!res.destroyed) deny(res); });
            req.on('error', () => upstream?.destroy());
            req.pipe(upstream);
        } catch { if (!res.destroyed) deny(res); }
    });
    server.on('connect', (req, rawClient, head) => {
        const client = rawClient as Socket;
        let upstream: Socket | undefined;
        const timer = setTimeout(() => { client.destroy(); upstream?.destroy(); }, RESOURCE_LIMITS.requestTimeoutMs);
        client.once('close', () => { clearTimeout(timer); upstream?.destroy(); });
        client.on('error', () => upstream?.destroy());
        void (async () => {
            try {
                const authority = req.url || '';
                // URL alone accepts paths and credentials; CONNECT does not.
                if (!/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+):[0-9]+$/.test(authority)) throw new Error();
                const url = new URL('https://' + authority);
                const destination = await resolve(url);
                if (client.destroyed) return;
                upstream = (transports.connect ?? connect)({ host: destination.address, family: destination.family, port: destination.port });
                sockets.add(upstream);
                upstream.once('close', () => { sockets.delete(upstream!); client.destroy(); });
                upstream.on('error', () => client.destroy());
                upstream.once('connect', () => {
                    // CONNECT keeps the browser's hostname/SNI/certificate
                    // validation intact; we only choose the TCP destination.
                    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    if (head.length) upstream!.write(head);
                    upstream!.pipe(client);
                    client.pipe(upstream!);
                });
            } catch {
                if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            }
        })();
    });
    server.on('upgrade', (_req, socket) => socket.destroy());
    server.on('connection', socket => {
        if (sockets.size >= 128) { socket.destroy(); return; }
        sockets.add(socket);
        socket.setTimeout(RESOURCE_LIMITS.requestTimeoutMs, () => socket.destroy());
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.requestTimeout = RESOURCE_LIMITS.requestTimeoutMs;
    server.headersTimeout = RESOURCE_LIMITS.requestTimeoutMs;
    return {
        server,
        close: async () => {
            resolver.cancel();
            for (const socket of sockets) socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    };
}
