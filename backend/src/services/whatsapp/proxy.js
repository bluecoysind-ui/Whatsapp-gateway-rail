const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksClient } = require('socks');
const { Agent: UndiciAgent, ProxyAgent: UndiciProxyAgent, buildConnector } = require('undici');

/**
 * Per-session proxy support.
 *
 * Baileys needs two different kinds of agent:
 *   - `agent`      -> a Node http.Agent for the WebSocket to web.whatsapp.com
 *   - `fetchAgent` -> an undici Dispatcher for media upload/download via fetch()
 *
 * Both are built here from one proxy URL so a session's traffic — socket and
 * media — leaves through the same IP. Supported schemes:
 *   socks5://[user:pass@]host:port   (also socks5h, socks4, socks4a)
 *   http://[user:pass@]host:port     (HTTP CONNECT proxy; https:// for TLS to the proxy)
 */

/** Where /proxy/test fetches from to learn the egress IP. Override for air-gapped setups. */
const PROXY_CHECK_URL = process.env.PROXY_CHECK_URL || 'https://api.ipify.org?format=json';
const PROXY_CHECK_TIMEOUT_MS = Number(process.env.PROXY_CHECK_TIMEOUT_MS) || 15_000;

const SOCKS_TYPES = { socks4: 4, socks4a: 4, socks5: 5, socks5h: 5, socks: 5 };
const HTTP_TYPES = new Set(['http', 'https']);

/**
 * Validate and decompose a proxy URL.
 * @param {string} url
 * @returns {{ url: string, scheme: string, host: string, port: number, username: string|null, password: string|null }}
 * @throws {Error} on anything unusable
 */
function parseProxyUrl(url) {
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('Proxy URL is empty');
    }
    let parsed;
    try {
        parsed = new URL(url.trim());
    } catch {
        throw new Error('Proxy URL is not a valid URL (expected e.g. socks5://user:pass@host:1080)');
    }
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    if (!(scheme in SOCKS_TYPES) && !HTTP_TYPES.has(scheme)) {
        throw new Error(`Unsupported proxy scheme "${scheme}" — use socks5://, socks4:// or http(s)://`);
    }
    if (!parsed.hostname) {
        throw new Error('Proxy URL has no host');
    }
    const port = parsed.port ? Number(parsed.port) : scheme in SOCKS_TYPES ? 1080 : scheme === 'https' ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Proxy URL has an invalid port');
    }
    return {
        url: parsed.toString().replace(/\/$/, ''),
        scheme,
        host: parsed.hostname,
        port,
        username: parsed.username ? decodeURIComponent(parsed.username) : null,
        password: parsed.password ? decodeURIComponent(parsed.password) : null
    };
}

/** `socks5://user:***@host:1080` — safe for API responses and logs. */
function redactProxyUrl(url) {
    if (!url) return null;
    try {
        const p = new URL(url);
        if (p.password) p.password = '***';
        return p.toString().replace(/\/$/, '');
    } catch {
        return '***';
    }
}

/** undici connector that opens the TCP leg through a SOCKS proxy, then lets undici do TLS. */
function socksConnector(info) {
    const undiciConnect = buildConnector({ timeout: 10_000 });
    const proxy = {
        host: info.host,
        port: info.port,
        type: SOCKS_TYPES[info.scheme],
        userId: info.username || undefined,
        password: info.password || undefined
    };
    return async (options, callback) => {
        const { protocol, hostname, port } = options;
        let socket;
        try {
            ({ socket } = await SocksClient.createConnection({
                command: 'connect',
                proxy,
                timeout: 10_000,
                destination: { host: hostname, port: port ? Number(port) : protocol === 'http:' ? 80 : 443 }
            }));
        } catch (error) {
            return callback(error, null);
        }
        if (protocol !== 'https:') return callback(null, socket.setNoDelay());
        // Hand the raw socket to undici for the TLS upgrade.
        return undiciConnect({ ...options, httpSocket: socket }, callback);
    };
}

/**
 * Build the pair of agents Baileys needs for one proxy URL.
 * @param {string|null|undefined} url
 * @returns {{ agent: import('http').Agent, fetchAgent: import('undici').Dispatcher } | null}
 */
function buildProxyAgents(url) {
    if (!url) return null;
    const info = parseProxyUrl(url);

    if (info.scheme in SOCKS_TYPES) {
        return {
            agent: new SocksProxyAgent(info.url),
            fetchAgent: new UndiciAgent({ connect: socksConnector(info) })
        };
    }

    const token = info.username ? `Basic ${Buffer.from(`${info.username}:${info.password || ''}`).toString('base64')}` : undefined;
    return {
        agent: new HttpsProxyAgent(info.url),
        fetchAgent: new UndiciProxyAgent({ uri: `${info.scheme}://${info.host}:${info.port}`, token })
    };
}

/**
 * Fetch PROXY_CHECK_URL through the proxy and report the egress IP.
 * @param {string} url - proxy URL
 * @returns {Promise<{ ok: boolean, ip?: string, latencyMs?: number, error?: string, proxy: string|null }>}
 */
async function checkProxy(url) {
    const started = Date.now();
    let agents;
    try {
        agents = buildProxyAgents(url);
    } catch (error) {
        return { ok: false, error: error.message, proxy: redactProxyUrl(url) };
    }
    if (!agents) return { ok: false, error: 'Proxy URL is empty', proxy: null };

    try {
        const response = await fetch(PROXY_CHECK_URL, {
            dispatcher: agents.fetchAgent,
            signal: AbortSignal.timeout(PROXY_CHECK_TIMEOUT_MS),
            headers: { 'User-Agent': 'chatery-proxy-check' }
        });
        const text = await response.text();
        if (!response.ok) {
            return { ok: false, error: `Check URL answered HTTP ${response.status}`, proxy: redactProxyUrl(url) };
        }
        let ip = text.trim();
        try {
            const json = JSON.parse(text);
            if (json && typeof json.ip === 'string') ip = json.ip;
        } catch {
            /* plain-text responders are fine */
        }
        return { ok: true, ip, latencyMs: Date.now() - started, proxy: redactProxyUrl(url) };
    } catch (error) {
        const message = error.name === 'TimeoutError' ? `No answer through the proxy within ${PROXY_CHECK_TIMEOUT_MS / 1000}s` : error.cause?.message || error.message;
        return { ok: false, error: message, latencyMs: Date.now() - started, proxy: redactProxyUrl(url) };
    } finally {
        try {
            await agents.fetchAgent.close();
        } catch {
            /* nothing to release */
        }
    }
}

module.exports = { parseProxyUrl, redactProxyUrl, buildProxyAgents, checkProxy, PROXY_CHECK_URL };
