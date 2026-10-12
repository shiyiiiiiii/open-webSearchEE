import { writeFileSync } from 'node:fs';
import { BROWSER_NETWORK_ARGS, boundedBrowserCleanup, getBrowserEgressProxy } from '../utils/browserNetworkPolicy.js';
import { config } from '../config.js';
import { loadPlaywrightClient } from '../utils/playwrightClient.js';

const client = await loadPlaywrightClient();
const chromium = client?.chromium as any;
if (typeof chromium?.launchServer !== 'function') throw new Error('Browser worker requires Chromium launchServer');
const server = await chromium.launchServer({
    host: '0.0.0.0', port: 3000, wsPath: '/open-websearch', headless: true,
    executablePath: config.playwrightExecutablePath,
    proxy: getBrowserEgressProxy(), args: BROWSER_NETWORK_ARGS
});
writeFileSync('/tmp/browser-worker-ready', 'ready');
console.error('Controlled browser worker ready');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void boundedBrowserCleanup(server.close()).then(() => process.exit(0)); });
}
