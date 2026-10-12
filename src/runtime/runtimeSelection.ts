import { commandNeedsRuntime } from '../cli/runCli.js';
import { isMcpServerInvocation } from '../adapters/http/serverOptions.js';

export function shouldCreateFullRuntimeForInvocation(argv: string[]): boolean {
    return isMcpServerInvocation(argv) || commandNeedsRuntime(argv);
}
