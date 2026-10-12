// Conservative service budgets shared by every entry point.
export const RESOURCE_LIMITS = Object.freeze({
    requestTimeoutMs: 15_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxSearchEngines: 3,
    maxEngineInputs: 16,
    maxQueryChars: 2048,
    maxConcurrentSearches: 4,
    maxConcurrentFetches: 4,
    maxMcpSessions: 16,
    sessionIdleTimeoutMs: 5 * 60_000,
    maxBrowserPages: 4,
    maxCookieCacheEntries: 64
});

export class ResourceLimitError extends Error {
    readonly code = 'resource_limit';
}

export function boundedRequestLimit(value: number | undefined, maximum: number): number {
    return value !== undefined && Number.isFinite(value) && value > 0
        ? Math.min(value, maximum)
        : maximum;
}
