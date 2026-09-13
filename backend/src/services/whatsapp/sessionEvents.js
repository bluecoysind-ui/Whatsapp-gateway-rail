/**
 * Session lifecycle hooks.
 *
 * One plain function per event. Today they log; this is the place to call an
 * external API / callback later (CRM, billing, alerting…) without touching the
 * connection code in WhatsAppSession. Both are also forwarded to the session's
 * webhooks and the WebSocket room so existing integrations see them too.
 *
 * Details passed to every hook:
 *   sessionId, phoneNumber, name, timestamp
 *   onSessionDisconnected additionally: reason, loggedOut (phone unlinked /
 *   deleted — will NOT come back by itself), willReconnect (gateway retrying)
 */

const wsManager = require('../websocket/WebSocketManager');

const label = (d) => `${d.name || 'unknown'} (${d.phoneNumber || 'no number'}) [session ${d.sessionId}]`;

/**
 * An account finished linking or came back online.
 * @param {{ sessionId: string, phoneNumber: string|null, name: string|null }} details
 * @param {{ sendWebhook?: (event: string, data: object) => void }} [io]
 */
function onSessionConnected(details, io = {}) {
    const payload = { ...details, timestamp: new Date().toISOString() };
    console.log(`🟢 User ${label(payload)} connected`);

    // TODO(callback): call your external API here, e.g.
    // await fetch(process.env.SESSION_CALLBACK_URL, { method: 'POST', body: JSON.stringify({ event: 'session.connected', ...payload }) })

    wsManager.emitSessionConnected(details.sessionId, payload);
    io.sendWebhook?.('session.connected', payload);
    return payload;
}

/**
 * A previously connected account went away.
 * @param {{ sessionId: string, phoneNumber: string|null, name: string|null, reason: string|null, loggedOut: boolean, willReconnect: boolean }} details
 * @param {{ sendWebhook?: (event: string, data: object) => void }} [io]
 */
function onSessionDisconnected(details, io = {}) {
    const payload = { ...details, timestamp: new Date().toISOString() };
    if (payload.loggedOut) {
        console.log(`🔴 User ${label(payload)} logged out${payload.reason ? ` — ${payload.reason}` : ''}`);
    } else {
        console.log(`🟠 User ${label(payload)} disconnected${payload.reason ? ` — ${payload.reason}` : ''}${payload.willReconnect ? ' (reconnecting)' : ''}`);
    }

    // TODO(callback): call your external API here, e.g.
    // await fetch(process.env.SESSION_CALLBACK_URL, { method: 'POST', body: JSON.stringify({ event: 'session.disconnected', ...payload }) })

    wsManager.emitSessionDisconnected(details.sessionId, payload);
    io.sendWebhook?.('session.disconnected', payload);
    return payload;
}

module.exports = { onSessionConnected, onSessionDisconnected };
