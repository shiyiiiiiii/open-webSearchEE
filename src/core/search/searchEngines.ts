import { RESOURCE_LIMITS } from '../../utils/resourceLimits.js';

export const SUPPORTED_SEARCH_ENGINES = [
    'baidu',
    'bing',
    'linuxdo',
    'csdn',
    'duckduckgo',
    'exa',
    'brave',
    'juejin',
    'startpage',
    'sogou',
    'hackernews'
] as const;

export type SupportedSearchEngine = typeof SUPPORTED_SEARCH_ENGINES[number];

export function normalizeEngineName(engine: string): string {
    const cleaned = engine.trim().toLowerCase();
    const compact = cleaned.replace(/[\s._-]+/g, '');

    switch (compact) {
        case 'baidu':
            return 'baidu';
        case 'bing':
            return 'bing';
        case 'linuxdo':
            return 'linuxdo';
        case 'csdn':
            return 'csdn';
        case 'duckduckgo':
            return 'duckduckgo';
        case 'exa':
            return 'exa';
        case 'brave':
            return 'brave';
        case 'juejin':
            return 'juejin';
        case 'startpage':
            return 'startpage';
        case 'sogou':
        case 'sougou':
        case '搜狗':
            return 'sogou';
        case 'hackernews':
        case 'hn':
            return 'hackernews';
        default:
            return cleaned;
    }
}

export function distributeLimit(totalLimit: number, engineCount: number): number[] {
    const base = Math.floor(totalLimit / engineCount);
    const remainder = totalLimit % engineCount;

    return Array.from({ length: engineCount }, (_, index) =>
        base + (index < remainder ? 1 : 0)
    );
}

export function resolveRequestedEngines(
    requestedEngines: string[],
    allowedSearchEngines: string[],
    defaultSearchEngine: string
): string[] {
    if (requestedEngines.length === 0 || requestedEngines.length > RESOURCE_LIMITS.maxEngineInputs) {
        throw new Error(`engines must contain between 1 and ${RESOURCE_LIMITS.maxEngineInputs} entries`);
    }
    const uniqueEngines = [...new Set(requestedEngines.map(normalizeEngineName))];
    const filteredEngines = allowedSearchEngines.length === 0
        ? uniqueEngines
        : uniqueEngines.filter(engine => allowedSearchEngines.includes(engine));
    const result = filteredEngines.length > 0 ? filteredEngines : [defaultSearchEngine];
    if (result.length > RESOURCE_LIMITS.maxSearchEngines) {
        throw new Error(`engines must contain at most ${RESOURCE_LIMITS.maxSearchEngines} different engines`);
    }
    return result;
}
