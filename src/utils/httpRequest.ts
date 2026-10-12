import axios, { AxiosError } from 'axios';
import type { AxiosRequestConfig, AxiosResponse, RawAxiosRequestHeaders, ResponseType } from 'axios';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction, TcpNetConnectOpts } from 'node:net';
import type { Duplex } from 'node:stream';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
    RequestFilteringHttpAgent,
    RequestFilteringHttpsAgent
} from 'request-filtering-agent';
import { config, getProxyUrl } from '../config.js';
import { assertPublicHttpUrlResolved, isBlockedDestinationIp, isPrivateOrLocalHostname } from './urlSafety.js';
import { RESOURCE_LIMITS, boundedRequestLimit } from './resourceLimits.js';

type BuildAxiosRequestOptions = {
    allowInsecureTls?: boolean;
    decompress?: boolean;
    headers?: RawAxiosRequestHeaders;
    maxBodyLength?: number;
    maxContentLength?: number;
    maxRedirects?: number;
    params?: unknown;
    responseType?: ResponseType;
    timeout?: number;
    tlsMaxVersion?: https.AgentOptions['maxVersion'];
    trustedStaticHost?: boolean;
    validateStatus?: AxiosRequestConfig['validateStatus'];
};

const filteringHttpAgents = new Map<string, RequestFilteringHttpAgent>();
const secureFilteringHttpsAgents = new Map<string, RequestFilteringHttpsAgent>();
const insecureFilteringHttpsAgents = new Map<string, RequestFilteringHttpsAgent>();
let trustedStaticHttpAgent: RequestFilteringHttpAgent | null = null;
const trustedStaticHttpsAgents = new Map<string, RequestFilteringHttpsAgent>();
const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

function buildFakeIpAgentCacheKey(): string {
    return config.fakeIpCidrs.join(',');
}

function buildFakeIpAllowlistOptions() {
    return config.fakeIpCidrs.length > 0 ? { allowIPAddressList: config.fakeIpCidrs } : {};
}

function guardDestinationConnections(options: TcpNetConnectOpts): TcpNetConnectOpts {
    const rejection = (address: string) => new Error(`DNS lookup ${address} is not allowed by destination network policy`);
    if (options.host && isBlockedDestinationIp(options.host)) {
        throw rejection(options.host);
    }
    const lookup: LookupFunction = options.lookup ?? dnsLookup;
    return {
        ...options,
        lookup: (hostname, lookupOptions, callback) => {
            lookup(hostname, lookupOptions, (error, addresses, family) => {
                if (error) {
                    callback(error, addresses, family);
                    return;
                }
                const candidates = Array.isArray(addresses) ? addresses.map(entry => entry.address) : [addresses];
                const blocked = candidates.find(isBlockedDestinationIp);
                if (blocked) {
                    callback(rejection(blocked), '');
                    return;
                }
                callback(null, addresses, family);
            });
        }
    };
}

// Run mandatory policy before the dependency's fake-IP allowlist, including
// DNS results used for the actual socket rather than only preflight results.
class DestinationFilteringHttpAgent extends RequestFilteringHttpAgent {
    override createConnection(options: TcpNetConnectOpts, listener?: (error: Error | null, socket: Duplex) => void): Duplex {
        return super.createConnection(guardDestinationConnections(options), listener);
    }
}

class DestinationFilteringHttpsAgent extends RequestFilteringHttpsAgent {
    override createConnection(options: TcpNetConnectOpts, listener?: (error: Error | null, socket: Duplex) => void): Duplex {
        return super.createConnection(guardDestinationConnections(options), listener);
    }
}

function getFilteringHttpAgent(): RequestFilteringHttpAgent {
    const cacheKey = buildFakeIpAgentCacheKey();
    const cached = filteringHttpAgents.get(cacheKey);
    if (cached) {
        return cached;
    }
    const agent = new DestinationFilteringHttpAgent(buildFakeIpAllowlistOptions());
    filteringHttpAgents.set(cacheKey, agent);
    return agent;
}

function getFilteringHttpsAgent(allowInsecureTls: boolean): RequestFilteringHttpsAgent {
    const cacheKey = `${allowInsecureTls ? 'insecure' : 'secure'}::${buildFakeIpAgentCacheKey()}`;
    const cache = allowInsecureTls ? insecureFilteringHttpsAgents : secureFilteringHttpsAgents;
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const agent = new DestinationFilteringHttpsAgent({
        ...buildFakeIpAllowlistOptions(),
        rejectUnauthorized: !allowInsecureTls
    });
    cache.set(cacheKey, agent);
    return agent;
}

function getProxyAgent(proxyUrl: string, allowInsecureTls: boolean): HttpsProxyAgent<string> {
    const cacheKey = `${proxyUrl}::${allowInsecureTls ? 'insecure' : 'secure'}`;
    const cachedAgent = proxyAgents.get(cacheKey);
    if (cachedAgent) {
        return cachedAgent;
    }

    const agent = new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: !allowInsecureTls
    });
    proxyAgents.set(cacheKey, agent);
    return agent;
}

function getTrustedStaticHttpAgent(): RequestFilteringHttpAgent {
    trustedStaticHttpAgent ??= new DestinationFilteringHttpAgent({
        allowPrivateIPAddress: true,
        allowMetaIPAddress: true
    });
    return trustedStaticHttpAgent;
}

function getTrustedStaticHttpsAgent(
    allowInsecureTls: boolean,
    maxVersion?: https.AgentOptions['maxVersion']
): RequestFilteringHttpsAgent {
    const cacheKey = `${maxVersion || 'default'}::${allowInsecureTls ? 'insecure' : 'secure'}`;
    const cachedAgent = trustedStaticHttpsAgents.get(cacheKey);
    if (cachedAgent) {
        return cachedAgent;
    }

    const agent = new DestinationFilteringHttpsAgent({
        allowPrivateIPAddress: true,
        allowMetaIPAddress: true,
        maxVersion,
        rejectUnauthorized: !allowInsecureTls
    });
    trustedStaticHttpsAgents.set(cacheKey, agent);
    return agent;
}

export function buildAxiosRequestOptions(options: BuildAxiosRequestOptions = {}): AxiosRequestConfig {
    const {
        allowInsecureTls = false,
        decompress,
        headers,
        maxBodyLength,
        maxContentLength,
        maxRedirects,
        params,
        responseType,
        timeout,
        tlsMaxVersion,
        trustedStaticHost = false,
        validateStatus
    } = options;

    const requestOptions: AxiosRequestConfig = {
        proxy: false,
        timeout: boundedRequestLimit(timeout, RESOURCE_LIMITS.requestTimeoutMs),
        maxContentLength: boundedRequestLimit(maxContentLength, RESOURCE_LIMITS.maxResponseBytes),
        maxBodyLength: boundedRequestLimit(maxBodyLength, RESOURCE_LIMITS.maxResponseBytes)
    };

    if (headers) {
        requestOptions.headers = headers;
    }
    const effectiveMaxRedirects = trustedStaticHost ? 0 : maxRedirects;
    if (effectiveMaxRedirects !== undefined) {
        requestOptions.maxRedirects = effectiveMaxRedirects;
    }
    if (responseType !== undefined) {
        requestOptions.responseType = responseType;
    }
    if (decompress !== undefined) {
        requestOptions.decompress = decompress;
    }
    if (validateStatus !== undefined) {
        requestOptions.validateStatus = validateStatus;
    }
    if (params !== undefined) {
        requestOptions.params = params;
    }

    // Sync-only hook (follow-redirects constraint) — catches literal-IP
    // private targets. Hostname-on-redirect in proxy mode still relies on
    // the initial-URL DNS check.
    requestOptions.beforeRedirect = (opts) => {
        const target = (opts.hostname ?? opts.host) as string | undefined;
        if (target && isPrivateOrLocalHostname(target)) {
            throw new Error('Redirect target points to a private or local network address');
        }
    };

    const effectiveProxyUrl = getProxyUrl();
    if (effectiveProxyUrl) {
        const proxyAgent = getProxyAgent(effectiveProxyUrl, allowInsecureTls);
        requestOptions.httpAgent = proxyAgent;
        requestOptions.httpsAgent = proxyAgent;
    } else if (trustedStaticHost) {
        // Fixed search/API hosts may use carrier/proxy addresses such as
        // 100.64.0.0/10, but cannot bypass explicitly blocked destination ranges.
        requestOptions.httpAgent = getTrustedStaticHttpAgent();
        requestOptions.httpsAgent = getTrustedStaticHttpsAgent(allowInsecureTls, tlsMaxVersion);
    } else {
        requestOptions.httpAgent = getFilteringHttpAgent();
        requestOptions.httpsAgent = getFilteringHttpsAgent(allowInsecureTls);
    }

    return requestOptions;
}

type AxiosRequestFn = (config: AxiosRequestConfig) => Promise<AxiosResponse>;

let axiosRequestImpl: AxiosRequestFn = (config) => axios.request(config);

export function __setAxiosRequestForTests(impl?: AxiosRequestFn): void {
    axiosRequestImpl = impl ?? ((config) => axios.request(config));
}

// Manually chase redirects so we can async-DNS-resolve each hop. follow-redirects'
// beforeRedirect hook is sync, so in proxy mode (no request-filtering-agent) a
// redirect to a hostname resolving to 127.0.0.1 would otherwise slip through.
export async function requestWithSafeRedirects(
    method: 'GET' | 'HEAD',
    initialUrl: string,
    options: AxiosRequestConfig = {},
    urlLabel: string = 'Request URL'
): Promise<AxiosResponse> {
    const maxRedirects = options.maxRedirects ?? 5;
    const validateStatus = options.validateStatus ?? ((s: number) => s >= 200 && s < 300);
    let currentUrl = initialUrl;
    const timeoutMs = boundedRequestLimit(options.timeout, RESOURCE_LIMITS.requestTimeoutMs);
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const cancel = () => {
        controller.abort();
        rejectAbort(new AxiosError('Request canceled', AxiosError.ERR_CANCELED));
    };
    const timer = setTimeout(() => {
        controller.abort();
        rejectAbort(new AxiosError(`Request timed out after ${timeoutMs}ms`, AxiosError.ETIMEDOUT));
    }, timeoutMs);
    options.signal?.addEventListener?.('abort', cancel);

    try {
        if (options.signal?.aborted) cancel();
        for (let hops = 0; hops <= maxRedirects; hops++) {
            if (controller.signal.aborted) await aborted;
            await Promise.race([assertPublicHttpUrlResolved(currentUrl, hops === 0 ? urlLabel : 'Redirect target'), aborted]);

            const response = await Promise.race([axiosRequestImpl({
                ...options,
                method,
                url: currentUrl,
                signal: controller.signal,
                timeout: Math.max(1, deadline - Date.now()),
                maxContentLength: boundedRequestLimit(options.maxContentLength, RESOURCE_LIMITS.maxResponseBytes),
                maxBodyLength: boundedRequestLimit(options.maxBodyLength, RESOURCE_LIMITS.maxResponseBytes),
                maxRedirects: 0,
                // Accept 3xx here so we can inspect Location; caller's validateStatus
                // is re-applied to the final non-3xx response below.
                validateStatus: (s) => s >= 200 && s < 400,
            }), aborted]);

            const location = response.status >= 300 && response.status < 400
                ? response.headers?.location
                : undefined;

            if (location) {
                currentUrl = new URL(String(location), currentUrl).toString();
                continue;
            }

            if (response.request?.res && !response.request.res.responseUrl) {
                response.request.res.responseUrl = currentUrl;
            }
            if (!validateStatus(response.status)) {
                throw new AxiosError(
                    `Request failed with status code ${response.status}`,
                    AxiosError.ERR_BAD_RESPONSE,
                    response.config,
                    response.request,
                    response
                );
            }
            return response;
        }

        throw new Error(`Too many redirects (max ${maxRedirects})`);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener?.('abort', cancel);
    }
}
