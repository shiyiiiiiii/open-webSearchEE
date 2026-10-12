import * as dns from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { config } from '../config.js';

// These entire IPv4 prefixes are blocked by policy, including their mapped
// IPv6 forms. They cannot be exempted by synthetic DNS configuration.
export const BLOCKED_DESTINATION_CIDRS = [
    '10.0.0.0/8', '127.0.0.0/8', '172.0.0.0/8', '192.0.0.0/8',
    '::1/128',
    '::ffff:a00:0/104', '::ffff:7f00:0/104',
    '::ffff:ac00:0/104', '::ffff:c000:0/104'
];
const blockedDestinationNetworks = BLOCKED_DESTINATION_CIDRS.map(cidr => ipaddr.parseCIDR(cidr));

export function isBlockedDestinationIp(address: string): boolean {
    const host = stripIpv6Brackets(address);
    if (isIP(host) === 0) return false;
    const parsed = ipaddr.parse(host);
    return blockedDestinationNetworks.some(([network, prefix]) =>
        parsed.kind() === network.kind() && parsed.match(network, prefix)
    );
}

// URL.hostname preserves the brackets for IPv6 literals (`[::1]`), which
// break isIP and dns.lookup. Strip them once here.
function stripIpv6Brackets(host: string): string {
    const withoutRootDots = host.replace(/\.+$/, '');
    return withoutRootDots.startsWith('[') && withoutRootDots.endsWith(']')
        ? withoutRootDots.slice(1, -1)
        : withoutRootDots;
}

type LookupResult = Array<{ address: string }>;
export type DnsLookupFn = (hostname: string) => Promise<LookupResult>;

let dnsLookupForSafety: DnsLookupFn = async (hostname) => {
    return dns.lookup(hostname, { all: true, verbatim: true });
};

function isAllowedFakeIp(address: string): boolean {
    if (isIP(address) === 0 || config.fakeIpCidrs.length === 0) {
        return false;
    }
    try {
        const parsed = ipaddr.parse(address);
        if (isBlockedDestinationIp(address)) {
            return false;
        }
        return config.fakeIpCidrs.some((cidr) => parsed.match(ipaddr.parseCIDR(cidr)));
    } catch {
        return false;
    }
}

export function __setDnsLookupForTests(lookup?: DnsLookupFn): void {
    dnsLookupForSafety = lookup ?? (async (hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
}

export function isPrivateOrLocalHostname(hostname: string): boolean {
    const host = stripIpv6Brackets(hostname.trim().toLowerCase());
    if (!host || host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }
    if (isIP(host) === 0) {
        return false;
    }
    try {
        return isBlockedDestinationIp(host) || ipaddr.process(host).range() !== 'unicast';
    } catch {
        return false;
    }
}

export function isPublicHttpUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return false;
        }
        return !isPrivateOrLocalHostname(parsed.hostname);
    } catch {
        return false;
    }
}

export function assertPublicHttpUrl(url: string | URL, label: string = 'URL'): void {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must use HTTP or HTTPS`);
    }
    if (isPrivateOrLocalHostname(parsed.hostname)) {
        // Literal private targets are blocked unconditionally. FAKE_IP_CIDRS
        // only exempts DNS-resolved answers, so no hint is shown here.
        throw new Error(`${label} points to a private or local network target (${parsed.hostname}), which is not allowed`);
    }
}

// DNS-resolves hostnames and rejects private answers. Needed for proxy mode,
// where request-filtering-agent isn't in the chain.
export async function assertPublicHttpUrlResolved(url: string | URL, label: string = 'URL'): Promise<void> {
    await resolvePublicHttpAddresses(url, label);
}

// Return the validated addresses so a connection owner can pin the socket to
// an IP rather than passing the hostname to another resolver. The browser
// egress proxy never exempts synthetic DNS answers.
export async function resolvePublicHttpAddresses(url: string | URL, label: string = 'URL', allowFakeIp = true, lookup: DnsLookupFn = dnsLookupForSafety): Promise<Array<{ address: string; family: number }>> {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    assertPublicHttpUrl(parsed, label);

    const host = stripIpv6Brackets(parsed.hostname);
    if (isIP(host) !== 0) {
        return [{ address: host, family: isIP(host) }];
    }

    let resolved: LookupResult;
    try {
        resolved = await lookup(host);
    } catch {
        throw new Error(`${label} could not be resolved`);
    }
    if (!resolved.length || resolved.some(entry => isIP(entry.address) === 0)) {
        throw new Error(`${label} could not be resolved to valid IP addresses`);
    }
    const blockedIps = resolved
        .filter((entry) => isPrivateOrLocalHostname(entry.address) && !(allowFakeIp && isAllowedFakeIp(entry.address)))
        .map((entry) => entry.address);
    if (blockedIps.length > 0) {
        const ipList = blockedIps.join(', ');
        const hint = blockedIps.some(isBlockedDestinationIp)
            ? 'These address ranges are always blocked; FAKE_IP_CIDRS cannot allow them.'
            : 'If these are synthetic fake-IP DNS results, set FAKE_IP_CIDRS to the CIDR configured by your proxy (for example 198.18.0.0/15)';
        throw new Error(`${label} (${parsed.hostname}) resolves to private IP(s) (${ipList}), which is not allowed. ${hint}`);
    }
    return resolved.map(entry => ({ address: entry.address, family: isIP(entry.address) }));
}
