import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { config } from '../config.js';
import { createBrowserEgressProxy, type BrowserEgressDecision } from '../utils/browserEgressProxy.js';

async function run() {
    let canaryHits = 0;
    const canary = createServer((req, res) => { canaryHits++; res.end(req.headers.host); });
    await new Promise<void>(resolve => canary.listen(0, '127.0.0.1', resolve));
    const canaryPort = (canary.address() as AddressInfo).port;
    let answer: Array<{ address: string }> = [{ address: '93.184.216.34' }];
    const destinations: string[] = [];
    const decisions: BrowserEgressDecision[] = [];
    const gateway = createBrowserEgressProxy({
        lookup: async () => answer,
        // The transport records the actual numeric destination and only maps
        // the already-approved public socket to this test's owned fixture.
        request: ((options: any, callback: any) => {
            assert.equal(options.hostname, '93.184.216.34');
            destinations.push(options.hostname);
            return request({ ...options, hostname: '127.0.0.1', port: canaryPort }, callback);
        }) as typeof request,
        connect: ((options: any) => {
            assert.equal(options.host, '93.184.216.34');
            destinations.push(options.host);
            return connect({ ...options, host: '127.0.0.1', port: canaryPort });
        }) as typeof connect
    });
    gateway.server.on('egressDecision', (decision: BrowserEgressDecision) => decisions.push(decision));
    await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
    const proxyPort = (gateway.server.address() as AddressInfo).port;
    const get = (target: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: proxyPort, path: target }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.on('error', reject); req.end();
    });
    const tunnel = (target: string) => new Promise<string>((resolve, reject) => {
        const socket = connect(proxyPort, '127.0.0.1');
        let response = '';
        socket.setTimeout(3000, () => { socket.destroy(); reject(Error('Tunnel fixture timed out')); });
        socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        socket.on('data', chunk => {
            response += chunk.toString();
            if (response.includes('Connection Established') && !response.includes('fixture-pinned')) {
                socket.write('GET / HTTP/1.1\r\nHost: fixture-pinned\r\nConnection: close\r\n\r\n');
            }
        });
        socket.on('error', reject);
        socket.on('close', () => resolve(response));
    });
    try {
        assert.deepEqual(await get('http://public.test/resource'), { status: 200, body: 'public.test' });
        assert((await tunnel('public.test:443')).includes('fixture-pinned'));
        assert.equal(destinations.length, 2);
        const baseline = canaryHits;
        for (const addresses of [
            [{ address: '127.0.0.1' }], [{ address: '::1' }], [{ address: '::ffff:192.1.2.3' }],
            [{ address: '93.184.216.34' }, { address: 'fd00::1' }], [{ address: '172.64.1.2' }],
            [{ address: '198.18.1.1' }], [], [{ address: 'invalid-address' }]
        ]) {
            answer = addresses;
            config.fakeIpCidrs = ['0.0.0.0/0', '::/0'];
            assert.equal((await get('http://public.test/changed-dns')).status, 403);
            assert((await tunnel('public.test:443')).includes('403 Forbidden'));
        }
        for (const target of ['http://127.0.0.1/', 'http://[::1]/', 'http://public.test:22/', 'http://user:pass@public.test/', '/origin-form']) {
            assert.equal((await get(target)).status, 403);
        }
        for (const target of ['user@public.test:443', 'public.test:443/path', '127.0.0.1:443', '[::1]:443']) {
            assert((await tunnel(target)).includes('403 Forbidden'));
        }
        assert.equal(destinations.length, 2, 'no rejected destination may reach either transport');
        assert.equal(canaryHits, baseline, 'private and rebound DNS must never connect to the canary');
        assert.deepEqual(decisions.filter(item => item.allowed).map(item => item.selectedAddress), destinations);
        assert(decisions.some(item => !item.allowed && item.addresses.includes('fd00::1')));
        assert(decisions.some(item => !item.allowed && item.hostname === '127.0.0.1'));
        const audit = JSON.stringify(decisions);
        assert(!audit.includes('/changed-dns') && !audit.includes('user:pass') && !audit.includes('/resource'));
        console.log('PASS: HTTP/CONNECT pin numeric IPs, preserve Host and bytes; all private/mixed/invalid/rebound DNS is denied before connection; audit decisions redact URL secrets');
    } finally {
        await gateway.close();
        canary.closeAllConnections();
        await new Promise<void>(resolve => canary.close(() => resolve()));
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
