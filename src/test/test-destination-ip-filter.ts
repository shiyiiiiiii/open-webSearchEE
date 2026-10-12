import assert from 'node:assert/strict';
import { isIP, Socket } from 'node:net';
import type { LookupFunction, TcpNetConnectOpts } from 'node:net';
import type { Duplex } from 'node:stream';
import { config } from '../config.js';
import { buildAxiosRequestOptions } from '../utils/httpRequest.js';

type Agent = { createConnection(options: TcpNetConnectOpts): Duplex };

function lookupDecision(agent: Agent, addresses: string[], all: boolean): Error | null {
    const originalConnect = Socket.prototype.connect;
    let decision: Error | null | undefined;
    let socket: Duplex | undefined;
    // Exercise the actual agent's lookup chain without permitting any TCP
    // connection, even if the policy regresses and accepts a forbidden IP.
    Socket.prototype.connect = function(this: Socket, ...args: any[]): Socket {
        const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as TcpNetConnectOpts;
        assert(options.lookup, 'agent must provide a connection-time DNS filter');
        options.lookup('connection-dns.example', { all }, error => { decision = error; });
        return this;
    } as typeof Socket.prototype.connect;
    try {
        const lookup: LookupFunction = (_hostname, _options, callback) => {
            callback(null, all ? addresses.map(address => ({ address, family: isIP(address) })) : addresses[0], isIP(addresses[0]));
        };
        socket = agent.createConnection({ host: 'connection-dns.example', port: 443, lookup });
        assert.notEqual(decision, undefined, 'the connection lookup must be checked');
        return decision as Error | null;
    } finally {
        Socket.prototype.connect = originalConnect;
        socket?.on('error', () => undefined);
        socket?.destroy();
    }
}

function main(): void {
    const previousUseProxy = config.useProxy;
    const previousFakeIpCidrs = config.fakeIpCidrs;
    const blocked = ['10.1.2.3', '172.0.0.1', '172.64.1.2', '172.255.255.255', '192.1.2.3', '192.255.255.255', '127.0.0.1', '::1', '::ffff:172.64.1.2', '::ffff:192.1.2.3'];
    try {
        config.useProxy = false;
        for (const fakeIpCidrs of [[], ['198.18.0.0/15'], ['0.0.0.0/0', '::/0']]) {
            config.fakeIpCidrs = fakeIpCidrs;
            for (const trustedStaticHost of [false, true]) {
                const options = buildAxiosRequestOptions({ trustedStaticHost });
                for (const agent of [options.httpAgent, options.httpsAgent] as Agent[]) {
                    for (const address of blocked) {
                        assert.throws(() => agent.createConnection({ host: address, port: 443 }), /destination network policy/);
                        for (const all of [false, true]) {
                            assert.match(lookupDecision(agent, [address], all)?.message || '', /destination network policy/);
                        }
                    }
                    assert.match(lookupDecision(agent, ['8.8.8.8', '172.64.1.2'], true)?.message || '', /destination network policy/);
                    assert.equal(lookupDecision(agent, ['8.8.8.8'], true), null, 'public DNS answers must remain allowed');
                    if (trustedStaticHost) {
                        assert.equal(lookupDecision(agent, ['100.64.0.1'], true), null, 'fixed hosts must retain carrier/proxy compatibility');
                    } else if (fakeIpCidrs.length > 0) {
                        assert.equal(lookupDecision(agent, ['198.18.1.2'], true), null, 'synthetic DNS exceptions outside blocked ranges must still work');
                    }
                }
            }
        }
        console.log('✅ HTTP/HTTPS connections block all configured prefixes before TCP, including mixed DNS results, broad fake-IP allowlists and trusted hosts');
        console.log('✅ public destinations, permitted synthetic DNS and fixed-host carrier addresses remain supported');
        console.log('\nDestination IP filtering tests passed.');
    } finally {
        config.useProxy = previousUseProxy;
        config.fakeIpCidrs = previousFakeIpCidrs;
    }
}

main();
