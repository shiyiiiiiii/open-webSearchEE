import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RESOURCE_LIMITS } from '../utils/resourceLimits.js';

async function request(port: number, method: string, path: string, body?: unknown, sessionId?: string, accept = 'application/json, text/event-stream'): Promise<{ status: number; sessionId?: string }> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path, method,
            headers: {
                Accept: accept,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(sessionId ? { 'mcp-session-id': sessionId } : {})
            }
        }, res => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode!, sessionId: res.headers['mcp-session-id'] as string | undefined }));
        });
        req.setTimeout(5000, () => req.destroy(new Error('Fixture request timeout')));
        req.on('error', reject);
        req.end(payload);
    });
}

async function main(): Promise<void> {
    const reserved = http.createServer();
    reserved.listen(0, '127.0.0.1');
    await once(reserved, 'listening');
    const port = (reserved.address() as import('node:net').AddressInfo).port;
    await new Promise<void>(resolve => reserved.close(() => resolve()));
    const child = spawn(process.execPath, ['build/index.js', '--port', String(port), '--local-only'], {
        cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MODE: 'http', PORT: '1', LOCAL_ONLY: 'false', OPEN_WEBSEARCH_QUIET_STARTUP: 'true', SEARCH_MODE: 'request' }
    });
    let output = '';
    child.stdout!.resume();
    child.stderr!.on('data', chunk => { output += chunk.toString(); });
    const ids = new Set<string>();
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { cleanup(); reject(new Error('Startup timed out: ' + output)); }, 10000);
            const ready = () => {
                if (output.includes('HTTP server running')) { cleanup(); resolve(); }
            };
            const exited = () => { cleanup(); reject(new Error('Server exited before startup: ' + output)); };
            const cleanup = () => { clearTimeout(timeout); child.stderr!.removeListener('data', ready); child.removeListener('exit', exited); };
            child.stderr!.on('data', ready);
            child.once('exit', exited);
            ready();
        });
        assert(output.includes('port ' + port + ' (127.0.0.1)'), 'CLI flags must override PORT and bind loopback');
        const initialize = {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'resource-limit-fixture', version: '1.0' } }
        };
        for (let i = 0; i < RESOURCE_LIMITS.maxMcpSessions + 2; i++) {
            const rejected = await request(port, 'POST', '/mcp', initialize, undefined, 'application/octet-stream');
            assert.equal(rejected.status, 406, 'rejected initialization must immediately free its reservation');
        }
        for (let i = 0; i < RESOURCE_LIMITS.maxMcpSessions; i++) {
            const response = await request(port, 'POST', '/mcp', initialize);
            assert.equal(response.status, 200);
            assert(response.sessionId);
            ids.add(response.sessionId);
        }
        assert.equal(ids.size, 4);
        assert.equal((await request(port, 'POST', '/mcp', initialize)).status, 429);
        assert.equal((await request(port, 'GET', '/sse')).status, 429, 'legacy and streamable transports share one quota');
        const first = ids.values().next().value!;
        assert.equal((await request(port, 'DELETE', '/mcp', undefined, first)).status, 200);
        ids.delete(first);
        const replacement = await request(port, 'POST', '/mcp', initialize);
        assert.equal(replacement.status, 200, 'closing a session must immediately free capacity');
        assert(replacement.sessionId);
        ids.add(replacement.sessionId);
        console.log(`✅ real MCP startup flags, ${RESOURCE_LIMITS.maxMcpSessions}-session capacity, shared SSE quota and session release`);
    } finally {
        for (const id of ids) await request(port, 'DELETE', '/mcp', undefined, id).catch(() => undefined);
        if (child.exitCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
        }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
