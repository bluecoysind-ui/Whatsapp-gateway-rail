const { getProxyPool, isProxyRequired, redactProxyUrl } = require('./proxy');

/**
 * Gateway-wide proxy pool + rotation manager (singleton).
 *
 * Responsibilities:
 *   - Own the ordered proxy pool built from the environment.
 *   - Assign each account (session) a proxy, spreading accounts across the pool
 *     round-robin so load/egress-IPs are distributed.
 *   - Rotate an account onto the next healthy proxy when it hits a rate limit or
 *     repeated connection failures, putting the previous proxy on a short
 *     cooldown so we don't immediately bounce back onto it.
 *   - Never hand back "no proxy" while the pool is non-empty — combined with the
 *     session enforcing `required`, this guarantees no account connects directly.
 */
class ProxyManager {
    constructor() {
        /** @type {string[]} */
        this.pool = getProxyPool();
        this.required = isProxyRequired(this.pool);
        /** sessionId -> { index, url, rotations, assignedAt, rotatedAt, lastReason } */
        this.assignments = new Map();
        /** url -> timestamp (ms) until which the proxy is considered unhealthy */
        this.cooldowns = new Map();
        /** round-robin cursor for spreading accounts across the pool */
        this.cursor = 0;
        this.cooldownMs = Number(process.env.PROXY_COOLDOWN_MS) || 60_000;

        if (this.pool.length) {
            console.log(
                `[proxy] pool ready: ${this.pool.length} prox${this.pool.length === 1 ? 'y' : 'ies'}, ` +
                `direct connection ${this.required ? 'DISABLED' : 'allowed'}`
            );
        }
    }

    /** Re-read the pool from the environment (e.g. after a config change). */
    reload() {
        this.pool = getProxyPool();
        this.required = isProxyRequired(this.pool);
        // Drop assignments/cooldowns that point at proxies no longer in the pool.
        const live = new Set(this.pool.map((u) => u.toLowerCase()));
        for (const [sessionId, a] of this.assignments) {
            if (!live.has((a.url || '').toLowerCase())) this.assignments.delete(sessionId);
        }
        for (const url of [...this.cooldowns.keys()]) {
            if (!live.has(url.toLowerCase())) this.cooldowns.delete(url);
        }
        return this.pool.length;
    }

    size() {
        return this.pool.length;
    }

    isRequired() {
        return this.required;
    }

    _isHealthy(url) {
        const until = this.cooldowns.get(url);
        return !until || Date.now() >= until;
    }

    /**
     * Pick the next pool index after `fromIndex`, preferring a healthy proxy.
     * If every proxy is cooling down, fall back to the one whose cooldown ends
     * soonest so an account is never left without a proxy.
     */
    _nextIndex(fromIndex) {
        const n = this.pool.length;
        if (n === 0) return -1;
        for (let step = 1; step <= n; step++) {
            const idx = (fromIndex + step) % n;
            if (this._isHealthy(this.pool[idx])) return idx;
        }
        // All on cooldown — choose the soonest-to-recover.
        let best = (fromIndex + 1) % n;
        let bestUntil = Infinity;
        for (let idx = 0; idx < n; idx++) {
            const until = this.cooldowns.get(this.pool[idx]) || 0;
            if (until < bestUntil) {
                bestUntil = until;
                best = idx;
            }
        }
        return best;
    }

    /** First healthy index at or after `start` (for initial round-robin assignment). */
    _firstHealthyFrom(start) {
        const n = this.pool.length;
        for (let step = 0; step < n; step++) {
            const idx = (start + step) % n;
            if (this._isHealthy(this.pool[idx])) return idx;
        }
        return start % n;
    }

    /**
     * Assign (or return the existing) proxy for a session.
     * @returns {string|null} proxy URL, or null when the pool is empty
     */
    assign(sessionId) {
        if (!this.pool.length) return null;
        const existing = this.assignments.get(sessionId);
        if (existing && this.pool[existing.index] === existing.url) return existing.url;

        const index = this._firstHealthyFrom(this.cursor % this.pool.length);
        this.cursor = index + 1;
        const url = this.pool[index];
        this.assignments.set(sessionId, {
            index,
            url,
            rotations: 0,
            assignedAt: Date.now(),
            rotatedAt: null,
            lastReason: null
        });
        return url;
    }

    /** Current proxy URL for a session (assigns one if needed). */
    current(sessionId) {
        return this.assignments.get(sessionId)?.url || this.assign(sessionId);
    }

    /**
     * Rotate a session onto the next healthy proxy, cooling down the old one.
     * @returns {string|null} the new proxy URL
     */
    rotate(sessionId, reason = 'rotation') {
        if (!this.pool.length) return null;
        // Ensure the session has a starting assignment before we advance it.
        if (!this.assignments.has(sessionId)) this.assign(sessionId);
        const prev = this.assignments.get(sessionId);
        const fromIndex = prev ? prev.index : this.cursor % this.pool.length;

        // Cool the proxy we're leaving so we don't immediately return to it.
        if (prev?.url && this.pool.length > 1) {
            this.cooldowns.set(prev.url, Date.now() + this.cooldownMs);
        }

        const nextIndex = this._nextIndex(fromIndex);
        const url = this.pool[nextIndex];
        this.assignments.set(sessionId, {
            index: nextIndex,
            url,
            rotations: (prev?.rotations || 0) + 1,
            assignedAt: prev?.assignedAt || Date.now(),
            rotatedAt: Date.now(),
            lastReason: reason
        });
        return url;
    }

    /** Forget a session's assignment (on logout/delete). */
    release(sessionId) {
        this.assignments.delete(sessionId);
    }

    /** Per-session assignment info (raw URL — caller redacts for output). */
    info(sessionId) {
        if (sessionId && this.pool.length && !this.assignments.has(sessionId)) {
            this.assign(sessionId);
        }
        const a = this.assignments.get(sessionId) || null;
        return {
            url: a?.url || null,
            index: a ? a.index : null,
            rotations: a ? a.rotations : 0,
            rotatedAt: a ? a.rotatedAt : null,
            lastReason: a ? a.lastReason : null,
            poolSize: this.pool.length,
            required: this.required
        };
    }

    /** Gateway-wide pool status for dashboards (redacted). */
    poolStatus() {
        const now = Date.now();
        return {
            poolSize: this.pool.length,
            required: this.required,
            cooldownMs: this.cooldownMs,
            proxies: this.pool.map((url, index) => {
                const until = this.cooldowns.get(url) || 0;
                const assignedTo = [];
                for (const [sessionId, a] of this.assignments) {
                    if (a.url === url) assignedTo.push(sessionId);
                }
                return {
                    index,
                    proxy: redactProxyUrl(url),
                    healthy: now >= until,
                    cooldownRemainingMs: until > now ? until - now : 0,
                    assignedTo
                };
            })
        };
    }
}

module.exports = new ProxyManager();
