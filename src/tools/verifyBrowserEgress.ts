import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { config } from '../config.js';
import { getBrowserEgressProxy } from '../utils/browserNetworkPolicy.js';
import { loadPlaywrightClient } from '../utils/playwrightClient.js';

const canaryIp = '172.30.0.5';
if (process.argv.includes('--from-worker')) {
    // Run as uid worker in the browser container, independently of Chromium,
    // Playwright, application URL checks and browser proxy configuration.
    for (const [host, port] of [[canaryIp, 8080], ['127.0.0.1', 3000], ['::1', 3000]] as const) {
        const connected = await new Promise<boolean>(resolve => {
            const socket = connect({ host, port });
            const finish = (value: boolean) => { socket.destroy(); resolve(value); };
            socket.setTimeout(1000, () => finish(false));
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
        });
        assert(!connected, 'Browser namespace allowed a direct socket');
    }
    const udp = createSocket('udp4');
    udp.on('error', () => undefined);
    udp.send(Buffer.from('OWNED EGRESS CANARY'), 3478, canaryIp);
    await new Promise(resolve => setTimeout(resolve, 500));
    udp.close();
    console.log('Worker direct TCP probes denied; check the UDP counter from the app');
} else {
    const client = await loadPlaywrightClient();
    assert(client && config.playwrightWsEndpoint, 'Run this verifier in the deployed app container');
    const browser = await client.chromium.connect({ wsEndpoint: config.playwrightWsEndpoint });
    try {
        // Raw contexts deliberately omit every application guard.
        const direct = await browser.newContext({ proxy: { ...getBrowserEgressProxy(), bypass: '*' } });
        try {
            const page = await direct.newPage();
            for (const url of [`http://${canaryIp}:8080/`, 'http://127.0.0.1:3000/', 'http://[::1]:3000/']) {
                await assert.rejects(page.goto(url, { timeout: 1500 }));
            }
        } finally { await direct.close(); }
        const proxied = await browser.newContext({ proxy: getBrowserEgressProxy() });
        try {
            const page = await proxied.newPage();
            const response = await page.goto(`http://${canaryIp}:8080/`, { timeout: 3000 });
            assert.equal(response.status(), 403, 'Proxy must refuse a private target before connecting');
        } finally { await proxied.close(); }
        const brokenProxy = await browser.newContext({ proxy: { server: 'http://172.30.0.254:3128' } });
        try {
            const page = await brokenProxy.newPage();
            await assert.rejects(page.goto(`http://${canaryIp}:8080/`, { timeout: 1500 }));
        } finally { await brokenProxy.close(); }
        const stats = await fetch(`http://${canaryIp}:8081/`, { signal: AbortSignal.timeout(3000) }).then(res => res.json());
        assert.deepEqual(stats, { tcp: 0, http: 0, udp: 0 });
        console.log(JSON.stringify({ passed: true, browserVersion: browser.version(), privateCanary: stats }));
    } finally { await browser.close(); }
}
