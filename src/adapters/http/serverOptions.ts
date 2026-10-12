export type McpHttpOptions = { port: number; host: string };

export function isMcpServerInvocation(argv: string[]): boolean {
    return argv.length === 0 || argv[0] === '--port' || argv[0]?.startsWith('--port=') === true || argv[0] === '--local-only';
}

export function parseMcpHttpOptions(
    argv: string[],
    env: NodeJS.ProcessEnv = process.env
): McpHttpOptions {
    let portValue = env.PORT || '3000';
    let localOnly = env.LOCAL_ONLY === 'true';
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--local-only') {
            localOnly = true;
        } else if (arg === '--port') {
            const next = argv[++index];
            if (!next || next.startsWith('-')) throw new Error('Missing value for --port');
            portValue = next;
        } else if (arg.startsWith('--port=')) {
            portValue = arg.slice('--port='.length);
        } else {
            throw new Error(`Unknown MCP startup argument: ${arg}`);
        }
    }
    if (!/^\d+$/.test(portValue) || !Number.isInteger(Number(portValue)) || Number(portValue) < 1 || Number(portValue) > 65535) {
        throw new Error('Port must be an integer between 1 and 65535');
    }
    return { port: Number(portValue), host: localOnly ? '127.0.0.1' : '0.0.0.0' };
}
