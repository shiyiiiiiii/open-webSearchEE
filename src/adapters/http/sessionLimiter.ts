import { RESOURCE_LIMITS } from '../../utils/resourceLimits.js';

export type SessionLease = { touch(): void; release(): void };

// Reservations count immediately, before asynchronous MCP initialization.
export class SessionLimiter {
    private readonly entries = new Map<symbol, { touchedAt: number; expire: () => void }>();

    constructor(
        private readonly maximum: number = RESOURCE_LIMITS.maxMcpSessions,
        private readonly idleTimeoutMs: number = RESOURCE_LIMITS.sessionIdleTimeoutMs,
        private readonly now: () => number = Date.now
    ) {}

    acquire(expire: () => void): SessionLease | null {
        this.sweep();
        if (this.entries.size >= this.maximum) return null;
        const key = Symbol();
        this.entries.set(key, { touchedAt: this.now(), expire });
        return {
            touch: () => {
                const entry = this.entries.get(key);
                if (entry) entry.touchedAt = this.now();
            },
            release: () => { this.entries.delete(key); }
        };
    }

    sweep(): void {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (now - entry.touchedAt >= this.idleTimeoutMs) {
                this.entries.delete(key);
                entry.expire();
            }
        }
    }
}
