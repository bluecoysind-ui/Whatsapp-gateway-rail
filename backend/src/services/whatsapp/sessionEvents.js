/**
 * Session lifecycle hooks.
 *
 * One plain function per event. Connected/disconnected are forwarded to the
 * session's webhooks and the WebSocket room, and also to Bluecoys:
 *
 *   POST https://bluecoys.com/api/whatsapp-linked?phone_number=...
 *        body: { phone_number, username, name }
 *        — only when a QR scan successfully pairs the account
 *
 *   GET  https://bluecoys.com/api/whatsapp-disconnected?phone_number=...
 *        — when a previously connected account drops
 *
 * Override the URLs with WHATSAPP_LINKED_CALLBACK_URL /
 * WHATSAPP_DISCONNECTED_CALLBACK_URL. Set either to empty to disable that hook.
 *
 * Details passed to every hook:
 *   sessionId, phoneNumber, name, username, timestamp
 *   onSessionDisconnected additionally: reason, loggedOut (phone unlinked /
 *   deleted — will NOT come back by itself), willReconnect (gateway retrying)
 */

const wsManager = require('../websocket/WebSocketManager');

const DEFAULT_LINKED_URL = 'https://bluecoys.com/api/whatsapp-linked';
const DEFAULT_DISCONNECTED_URL = 'https://bluecoys.com/api/whatsapp-disconnected';

const label = (d) => `${d.name || d.username || 'unknown'} (${d.phoneNumber || 'no number'}) [session ${d.sessionId}]`;

function callbackBase(envKey, fallback) {
    const raw = process.env[envKey];
    if (raw === '') return null;
    return raw || fallback;
}

function withQuery(base, params) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
}

async function notifyLinked(payload) {
    const base = callbackBase('WHATSAPP_LINKED_CALLBACK_URL', DEFAULT_LINKED_URL);
    if (!base || !payload.phoneNumber) return;

    const url = withQuery(base, { phone_number: payload.phoneNumber });
    const body = {
        phone_number: payload.phoneNumber,
        username: payload.username || null,
        name: payload.name || null,
        sessionId: payload.sessionId
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            console.log(`⚠️ Linked callback ${response.status} for ${label(payload)}`);
            return;
        }
        console.log(`📤 Linked callback sent for ${label(payload)}`);
    } catch (error) {
        console.log(`⚠️ Linked callback error for ${label(payload)}: ${error.message}`);
    }
}

async function notifyDisconnected(payload) {
    const base = callbackBase('WHATSAPP_DISCONNECTED_CALLBACK_URL', DEFAULT_DISCONNECTED_URL);
    if (!base || !payload.phoneNumber) return;

    const url = withQuery(base, {
        phone_number: payload.phoneNumber,
        ...(payload.username ? { username: payload.username } : {})
    });

    try {
        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            console.log(`⚠️ Disconnected callback ${response.status} for ${label(payload)}`);
            return;
        }
        console.log(`📤 Disconnected callback sent for ${label(payload)}`);
    } catch (error) {
        console.log(`⚠️ Disconnected callback error for ${label(payload)}: ${error.message}`);
    }
}

/**
 * An account finished linking or came back online.
 * @param {{ sessionId: string, phoneNumber: string|null, name: string|null, username?: string|null, justLinked?: boolean }} details
 * @param {{ sendWebhook?: (event: string, data: object) => void }} [io]
 */
function onSessionConnected(details, io = {}) {
    const payload = {
        sessionId: details.sessionId,
        phoneNumber: details.phoneNumber || null,
        name: details.name || null,
        username: details.username || null,
        justLinked: Boolean(details.justLinked),
        timestamp: new Date().toISOString()
    };
    console.log(`🟢 User ${label(payload)} connected`);

    // Bluecoys linked callback: only after a QR pair (not later reconnects).
    if (payload.justLinked) {
        notifyLinked(payload).catch(() => {});
    }

    wsManager.emitSessionConnected(details.sessionId, payload);
    io.sendWebhook?.('session.connected', payload);
    return payload;
}

/**
 * A previously connected account went away.
 * @param {{ sessionId: string, phoneNumber: string|null, name: string|null, username?: string|null, reason: string|null, loggedOut: boolean, willReconnect: boolean }} details
 * @param {{ sendWebhook?: (event: string, data: object) => void }} [io]
 */
function onSessionDisconnected(details, io = {}) {
    const payload = {
        sessionId: details.sessionId,
        phoneNumber: details.phoneNumber || null,
        name: details.name || null,
        username: details.username || null,
        reason: details.reason || null,
        loggedOut: Boolean(details.loggedOut),
        willReconnect: Boolean(details.willReconnect),
        timestamp: new Date().toISOString()
    };
    if (payload.loggedOut) {
        console.log(`🔴 User ${label(payload)} logged out${payload.reason ? ` — ${payload.reason}` : ''}`);
    } else {
        console.log(`🟠 User ${label(payload)} disconnected${payload.reason ? ` — ${payload.reason}` : ''}${payload.willReconnect ? ' (reconnecting)' : ''}`);
    }

    notifyDisconnected(payload).catch(() => {});

    wsManager.emitSessionDisconnected(details.sessionId, payload);
    io.sendWebhook?.('session.disconnected', payload);
    return payload;
}

module.exports = { onSessionConnected, onSessionDisconnected };
