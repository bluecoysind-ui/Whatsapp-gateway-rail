const path = require('path');
const fs = require('fs');
const WhatsAppSession = require('./WhatsAppSession');
const wsManager = require('../websocket/WebSocketManager');

/**
 * WhatsApp Manager Class
 * Mengelola semua sesi WhatsApp (Singleton)
 */
class WhatsAppManager {
    constructor() {
        this.sessions = new Map();
        this.sessionsFolder = path.join(process.cwd(), 'sessions');
        this.initExistingSessions();
    }

    /**
     * Load existing sessions on startup
     */
    async initExistingSessions() {
        try {
            if (!fs.existsSync(this.sessionsFolder)) {
                fs.mkdirSync(this.sessionsFolder, { recursive: true });
                return;
            }

            const sessionDirs = fs.readdirSync(this.sessionsFolder);
            for (const sessionId of sessionDirs) {
                const sessionPath = path.join(this.sessionsFolder, sessionId);
                if (!fs.statSync(sessionPath).isDirectory()) continue;
                const credsPath = path.join(sessionPath, 'creds.json');
                if (!fs.existsSync(credsPath)) {
                    // Leftover folder from an expired/unpaired QR — do not resurrect it.
                    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch { /* ignore */ }
                    console.log(`🗑️ Skipping empty/expired session folder: ${sessionId}`);
                    continue;
                }
                console.log(`🔄 Restoring session: ${sessionId}`);
                const session = new WhatsAppSession(sessionId, {});
                this._bindSession(session);
                this.sessions.set(sessionId, session);
                await session.connect();
            }
        } catch (error) {
            console.error('Error initializing sessions:', error);
        }
    }

    /**
     * Create a new session or reconnect existing
     * @param {string} sessionId - Session identifier
     * @param {Object} options - Session options
     * @param {Object} options.metadata - Custom metadata to store with session
     * @param {Array} options.webhooks - Array of webhook configs [{ url, events }]
     * @returns {Object}
     */
    async createSession(sessionId, options = {}) {
        // Validate session ID
        if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
            return { 
                success: false, 
                message: 'Invalid session ID. Use only letters, numbers, underscore, and dash.' 
            };
        }

        // Check if session already exists
        if (this.sessions.has(sessionId)) {
            const existingSession = this.sessions.get(sessionId);
            
            // Update config if provided
            if (options.metadata || options.webhooks || options.proxy !== undefined) {
                existingSession.updateConfig(options);
            }
            this._bindSession(existingSession);
            
            if (existingSession.connectionStatus === 'connected') {
                return { 
                    success: false, 
                    message: 'Session already connected', 
                    data: existingSession.getInfo() 
                };
            }
            // Reconnect existing session
            await existingSession.connect();
            return { 
                success: true, 
                message: 'Reconnecting existing session', 
                data: existingSession.getInfo() 
            };
        }

        // Create new session with options
        const session = new WhatsAppSession(sessionId, options);
        this._bindSession(session);
        session._saveConfig(); // Save initial config
        this.sessions.set(sessionId, session);
        await session.connect();

        return { 
            success: true, 
            message: 'Session created', 
            data: session.getInfo() 
        };
    }

    /**
     * Get session by ID
     * @param {string} sessionId 
     * @returns {WhatsAppSession|undefined}
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    /**
     * Attach manager-owned callbacks on a session instance.
     */
    _bindSession(session) {
        if (!session) return;
        session.onQrExpired = (sessionId) => this.dropExpiredQrSession(sessionId);
    }

    /**
     * Remove one unpaired session whose QR (or pairing) expired.
     * Auth is already wiped by the session; this drops it from the live map
     * so it no longer appears in the dashboard.
     */
    dropExpiredQrSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return { success: true, removed: [] };
        if (session.registered || session.connectionStatus === 'connected') {
            return { success: false, message: 'Refusing to drop a linked session', removed: [] };
        }
        try { session._teardownSocket(); } catch { /* already closed */ }
        try { session.deleteAuthFolder(); } catch { /* already gone */ }
        this.sessions.delete(sessionId);
        wsManager.emitSessionStatus(sessionId, 'deleted', { reason: 'qr_expired' });
        console.log(`🗑️ Removed expired QR session: ${sessionId}`);
        return { success: true, removed: [sessionId] };
    }

    /**
     * Remove every in-memory session whose QR login expired.
     */
    removeExpiredQrSessions() {
        const removed = [];
        for (const [sessionId, session] of [...this.sessions.entries()]) {
            if (session.connectionStatus === 'qr_expired') {
                this.dropExpiredQrSession(sessionId);
                removed.push(sessionId);
            }
        }
        return { success: true, removed };
    }

    /**
     * Get all sessions info
     * @returns {Array}
     */
    getAllSessions() {
        this.removeExpiredQrSessions();
        const sessionsInfo = [];
        for (const [sessionId, session] of this.sessions) {
            sessionsInfo.push(session.getInfo());
        }
        return sessionsInfo;
    }

    /**
     * Delete a session
     * @param {string} sessionId 
     * @returns {Object}
     */
    async deleteSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { success: false, message: 'Session not found' };
        }

        await session.logout();
        this.sessions.delete(sessionId);
        // Dashboards drop the account on this; the close handler already sent
        // session.disconnected if it was online.
        wsManager.emitSessionStatus(sessionId, 'deleted');
        return { success: true, message: 'Session deleted successfully' };
    }

    /**
     * Get session QR code info
     * @param {string} sessionId 
     * @returns {Object|null}
     */
    getSessionQR(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        return session.getInfo();
    }

    /**
     * Poll until a session has a QR (or is already connected / expired).
     * @param {string} sessionId
     * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
     * @returns {Promise<Object|null>}
     */
    async waitForQr(sessionId, { timeoutMs = 45_000, intervalMs = 300 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const session = this.sessions.get(sessionId);
            if (!session) return null;
            const info = session.getInfo();
            if (info.qrCode || info.isConnected || info.status === 'qr_expired' || info.status === 'logged_out' || info.status === 'error') {
                return info;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return this.sessions.get(sessionId)?.getInfo() || null;
    }

    /**
     * Start (or reuse) a session keyed by phone number and wait for its QR.
     * Stores `username` on the session so the linked/disconnected callbacks can
     * send it back to Bluecoys.
     * @param {{ username: string, phoneNumber: string }} params
     */
    async startQrLink({ username, phoneNumber }) {
        const sessionId = phoneNumber;
        const options = {
            metadata: {
                username,
                expectedPhoneNumber: phoneNumber
            }
        };

        const existing = this.getSession(sessionId);
        if (existing) {
            existing.updateConfig(options);
            if (existing.connectionStatus === 'connected') {
                return { success: true, data: existing.getInfo() };
            }
            const hasFreshQr = existing.connectionStatus === 'qr_ready' && existing.qrCode;
            if (!hasFreshQr && existing.connectionStatus !== 'connecting') {
                await existing.connect();
            }
        } else {
            const created = await this.createSession(sessionId, options);
            if (!created.success && created.data?.status !== 'connected') {
                return { success: false, message: created.message, data: created.data || null };
            }
            if (created.data?.status === 'connected') {
                return { success: true, data: created.data };
            }
        }

        const info = await this.waitForQr(sessionId);
        if (!info) {
            return { success: false, message: 'Session not found', data: null };
        }
        return { success: Boolean(info.qrCode || info.isConnected), data: info };
    }

    /**
     * Request a phone-number pairing code for an unpaired session.
     * The session must already be connecting (QR available); the code is an
     * alternative to scanning.
     */
    async requestPairingCode(sessionId, phoneNumber) {
        const session = this.getSession(sessionId);
        if (!session) {
            return { success: false, message: 'Session not found. Create the session first.' };
        }
        return session.requestPairingCode(phoneNumber);
    }
}

module.exports = WhatsAppManager;
