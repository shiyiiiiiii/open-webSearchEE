import { createBrowserEgressProxy, type BrowserEgressDecision } from '../utils/browserEgressProxy.js';
import { writeFileSync } from 'node:fs';

const port = Number(process.env.BROWSER_EGRESS_LISTEN_PORT || 3128);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser egress listen port');
const proxy = createBrowserEgressProxy();
proxy.server.on('egressDecision', (decision: BrowserEgressDecision) => {
    console.error(JSON.stringify({ event: 'browser_egress_decision', ...decision }));
});
proxy.server.listen(port, process.env.BROWSER_EGRESS_LISTEN_HOST || '127.0.0.1');
proxy.server.on('listening', () => {
    if (process.env.BROWSER_EGRESS_READY_FILE) writeFileSync(process.env.BROWSER_EGRESS_READY_FILE, 'ready');
    console.error('Browser egress proxy ready');
});
proxy.server.on('error', () => { console.error('Browser egress proxy failed'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void proxy.close(); });
}
