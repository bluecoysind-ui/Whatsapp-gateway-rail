const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, getContentType, jidNormalizedUser } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

const BaileysStore = require('./BaileysStore');
const MessageFormatter = require('./MessageFormatter');
const wsManager = require('../websocket/WebSocketManager');
const { buildProxyAgents, redactProxyUrl } = require('./proxy');
const proxyManager = require('./ProxyManager');
const sessionEvents = require('./sessionEvents');

const QR_EXPIRY_MS = Number(process.env.QR_EXPIRY_MS) || 120_000;
/** Incoming media above this size is fetched on demand instead of auto-saved. */
const MEDIA_AUTOSAVE_MAX_BYTES = Number(process.env.MEDIA_AUTOSAVE_MAX_BYTES) || 25 * 1024 * 1024;

/**
 * WhatsApp Session Class
 * Mengelola satu sesi WhatsApp
 */
class WhatsAppSession {
    constructor(sessionId, options = {}) {
        this.sessionId = sessionId;
        this.socket = null;
        this.qrCode = null;
        this.connectionStatus = 'disconnected';
        this.authFolder = path.join(process.cwd(), 'sessions', sessionId);
        this.storeFile = path.join(this.authFolder, 'store.json');
        this.configFile = path.join(this.authFolder, 'config.json');
        this.mediaFolder = path.join(process.cwd(), 'public', 'media', sessionId);
        this.phoneNumber = null;
        this.name = null;
        this.store = null;
        this.storeInterval = null;
        this.qrTimer = null;
        this.qrExpired = false;
        this.qrExpiresAt = null;
        // True once the auth creds are paired/registered. A registered session must
        // NEVER be treated as an expired QR (that would delete its whole folder).
        this.registered = false;
        // Set when a QR is shown; consumed on the next 'open' so the linked
        // callback fires for a fresh pair, not for later reconnects.
        this._pendingLink = false;

        // Custom metadata and webhook
        this.metadata = options.metadata || {};
        this.webhooks = options.webhooks || []; // Array of { url, events? }
        this.proxy = options.proxy || null;
        // The proxy actually used by the live socket (explicit or pool-assigned).
        this.activeProxy = null;
        // Consecutive connection failures since the last successful 'open'.
        this._proxyFailures = 0;
        // Debounce: earliest time we may rotate the proxy again (ms epoch).
        this._nextProxyRotateAt = 0;
        // Guard against overlapping connect() calls creating two sockets on the
        // same credentials (WhatsApp answers that with a "conflict" disconnect).
        this._connecting = false;
        // Single pending reconnect timer so close events can't stack many.
        this._reconnectTimer = null;
        // messageId -> /media/... path for media we sent from a local file.
        this._pendingMediaPaths = new Map();

        // USync batch cooldown: no directory queries until this timestamp.
        this._usyncCooldownUntil = 0;

        // Load config if exists, then let constructor options win so a new
        // connect (e.g. QR link with username) is not overwritten by a stale file.
        this._loadConfig();
        if (options.metadata) {
            this.metadata = { ...this.metadata, ...options.metadata };
        }
        if (options.webhooks) this.webhooks = options.webhooks;
        if (options.proxy !== undefined) this.proxy = options.proxy || null;
    }

    /**
     * Load session config from file
     */
    _loadConfig() {
        try {
            if (fs.existsSync(this.configFile)) {
                const config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                this.metadata = config.metadata || this.metadata;
                this.webhooks = config.webhooks || this.webhooks;
                if (config.proxy !== undefined) this.proxy = config.proxy || null;
            }
        } catch (e) {
            console.log(`⚠️ [${this.sessionId}] Could not load config:`, e.message);
        }
    }

    /**
     * Save session config to file
     */
    _saveConfig() {
        try {
            if (!fs.existsSync(this.authFolder)) {
                fs.mkdirSync(this.authFolder, { recursive: true });
            }
            fs.writeFileSync(this.configFile, JSON.stringify({
                metadata: this.metadata,
                webhooks: this.webhooks,
                proxy: this.proxy
            }, null, 2));
        } catch (e) {
            console.log(`⚠️ [${this.sessionId}] Could not save config:`, e.message);
        }
    }

    /**
     * Update session config
     */
    updateConfig(options = {}) {
        if (options.metadata !== undefined) {
            this.metadata = { ...this.metadata, ...options.metadata };
        }
        if (options.webhooks !== undefined) {
            this.webhooks = options.webhooks;
        }
        if (options.proxy !== undefined) {
            this.proxy = options.proxy || null;
        }
        this._saveConfig();
        return this.getInfo();
    }

    /**
     * Add a webhook URL
     */
    addWebhook(url, events = ['all']) {
        // Check if already exists
        const exists = this.webhooks.find(w => w.url === url);
        if (exists) {
            exists.events = events;
        } else {
            this.webhooks.push({ url, events });
        }
        this._saveConfig();
        return this.getInfo();
    }

    /**
     * Remove a webhook URL
     */
    removeWebhook(url) {
        this.webhooks = this.webhooks.filter(w => w.url !== url);
        this._saveConfig();
        return this.getInfo();
    }

    /**
     * Send webhook notification to all configured webhook URLs
     */
    async _sendWebhook(event, data) {
        if (!this.webhooks || this.webhooks.length === 0) return;

        const payload = {
            event,
            sessionId: this.sessionId,
            metadata: this.metadata,
            data,
            timestamp: new Date().toISOString()
        };

        // Send to all webhooks in parallel
        const promises = this.webhooks.map(async (webhook) => {
            // Check if event should be sent to this webhook
            const events = webhook.events || ['all'];
            if (!events.includes('all') && !events.includes(event)) {
                return;
            }

            try {
                const response = await fetch(webhook.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Source': 'chatery-whatsapp-api',
                        'X-Session-Id': this.sessionId,
                        'X-Webhook-Event': event
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    console.log(`⚠️ [${this.sessionId}] Webhook to ${webhook.url} failed: ${response.status}`);
                }
            } catch (error) {
                console.log(`⚠️ [${this.sessionId}] Webhook to ${webhook.url} error:`, error.message);
            }
        });

        // Wait for all webhooks to complete (non-blocking)
        Promise.all(promises).catch(() => {});
    }

    // ==================== CONNECTION ====================

    /**
     * Fully drop the current socket: remove all listeners and end the underlying
     * WebSocket so it can never linger and "conflict" with a fresh connection.
     */
    _teardownSocket() {
        if (!this.socket) return;
        try {
            this.socket.ev.removeAllListeners();
        } catch {
            /* already gone */
        }
        try {
            this.socket.end(undefined);
        } catch {
            /* already closed */
        }
        this.socket = null;
    }

    async connect() {
        // A pending reconnect is now superseded by this explicit attempt.
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;

        // Never run two connection attempts / two sockets for one account at once.
        // WhatsApp resolves duplicate sockets on the same creds with a "conflict"
        // (connectionReplaced) disconnect, which otherwise loops forever.
        if (this._connecting) {
            console.log(`[${this.sessionId}] connect() ignored — an attempt is already in progress`);
            return { success: false, message: 'Connection already in progress' };
        }
        if (this.socket && (this.connectionStatus === 'connected' || this.connectionStatus === 'connecting')) {
            console.log(`[${this.sessionId}] connect() ignored — socket already ${this.connectionStatus}`);
            return { success: false, message: `Already ${this.connectionStatus}` };
        }

        // Drop any lingering (dead) socket before creating a new one.
        this._teardownSocket();

        this._connecting = true;
        try {
            this._clearQrTimer();
            this.qrExpired = false;

            // Pastikan folder auth ada
            if (!fs.existsSync(this.authFolder)) {
                fs.mkdirSync(this.authFolder, { recursive: true });
            }

            // Initialize custom in-memory store with sessionId
            this.store = new BaileysStore(this.sessionId);

            // Load existing store data if available
            if (fs.existsSync(this.storeFile)) {
                try {
                    this.store.readFromFile(this.storeFile);
                    console.log(`📂 [${this.sessionId}] Store data loaded from file`);
                } catch (e) {
                    console.log(`⚠️ [${this.sessionId}] Could not load store file:`, e.message);
                }
            }

            // Save store periodically (every 30 seconds) and cleanup old media
            if (this.storeInterval) clearInterval(this.storeInterval);
            this.storeInterval = setInterval(() => {
                try {
                    // Cleanup old media files before saving (keep only last 100 per chat)
                    this.store.cleanupOldMedia(100);
                    this.store.writeToFile(this.storeFile);
                } catch (e) {
                    // Silent fail
                }
            }, 30_000);

            // Decide the egress proxy and whether direct connection is forbidden.
            //   - An explicit per-session proxy (this.proxy) always wins and is sticky.
            //   - Otherwise the account is assigned one from the rotating pool.
            //   - `proxyRequired` means: never connect directly — if no proxy can be
            //     built we back off and retry instead of falling through to a raw link.
            const usingPool = !this.proxy && proxyManager.size() > 0;
            let effectiveProxy = this.proxy || (usingPool ? proxyManager.current(this.sessionId) : null);
            const proxyRequired = this.proxy ? true : (proxyManager.size() > 0 && proxyManager.isRequired());

            let proxyAgents = null;
            if (effectiveProxy) {
                // Try to build agents; for pool proxies, rotate through the ring if an
                // entry is unusable so one bad proxy can't strand the account.
                const maxAttempts = usingPool ? Math.max(1, proxyManager.size()) : 1;
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    try {
                        proxyAgents = buildProxyAgents(effectiveProxy);
                        break;
                    } catch (error) {
                        console.error(`[${this.sessionId}] Unusable proxy ${redactProxyUrl(effectiveProxy)}: ${error.message}`);
                        if (!usingPool) break;
                        effectiveProxy = proxyManager.rotate(this.sessionId, `build failed: ${error.message}`);
                    }
                }
            }

            if (!proxyAgents && proxyRequired) {
                // Enforcement: no usable proxy AND direct connection is disabled.
                // Do NOT create a socket — back off and retry so the account keeps
                // trying to come up through a proxy rather than leaking direct.
                this.connectionStatus = 'error';
                this.activeProxy = null;
                const msg = 'No usable proxy available and direct connection is disabled';
                console.error(`[${this.sessionId}] ${msg} — retrying in 15s`);
                wsManager.emitSessionStatus(this.sessionId, 'error', { reason: msg });
                this._sendWebhook('connection.update', { status: 'error', reason: msg });
                clearTimeout(this._proxyRetryTimer);
                this._proxyRetryTimer = setTimeout(() => this.connect(), 15_000);
                return { success: false, message: msg };
            }

            this.activeProxy = proxyAgents ? effectiveProxy : null;
            if (proxyAgents) {
                const source = this.proxy ? 'session' : 'pool';
                console.log(`[${this.sessionId}] Connecting through proxy ${redactProxyUrl(effectiveProxy)} (${source})`);
            }

            const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
            this.registered = Boolean(state.creds && state.creds.registered);
            const { version } = await fetchLatestBaileysVersion();

            this.socket = makeWASocket({
                version,
                auth: state,
                logger: pino({ level: 'silent' }),
                browser: ['Chatery API', 'Chrome', '1.0.0'],
                syncFullHistory: true,
                ...(proxyAgents ? { agent: proxyAgents.agent, fetchAgent: proxyAgents.fetchAgent } : {})
            });

            // Bind store to socket events
            this.store.bind(this.socket.ev);

            // Setup event listeners
            this._setupEventListeners(saveCreds);

            return { success: true, message: 'Initializing connection...' };
        } catch (error) {
            console.error(`[${this.sessionId}] Error connecting:`, error);
            this.connectionStatus = 'error';
            return { success: false, message: error.message };
        } finally {
            // The socket now owns its lifecycle via connection.update events;
            // release the re-entrancy guard so future reconnects can proceed.
            this._connecting = false;
        }
    }

    /**
     * Drop the live socket so the close handler reconnects with the current
     * config (e.g. a new proxy). Credentials are kept - no new QR needed.
     */
    async restart(reason = 'Restart requested') {
        if (!this.socket) return this.connect();
        try {
            console.log(`[${this.sessionId}] Restarting connection: ${reason}`);
            this.socket.end(new Error(reason));
            return { success: true, message: 'Reconnecting with the current configuration' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    _startQrExpiryTimer() {
        if (this.qrTimer) return;
        this.qrExpiresAt = Date.now() + QR_EXPIRY_MS;
        this.qrTimer = setTimeout(() => {
            this.qrTimer = null;
            if (this.connectionStatus !== 'qr_ready' && this.connectionStatus !== 'connecting') return;
            console.log(`[${this.sessionId}] QR expiry timer fired - revoking session.`);
            this.qrExpired = true;
            try {
                this.socket?.end(new Error('QR code expired'));
            } catch (e) {
                this._markQrExpired('QR code expired');
            }
            if (!this.socket) this._markQrExpired('QR code expired');
        }, QR_EXPIRY_MS);
    }

    _clearQrTimer() {
        if (this.qrTimer) {
            clearTimeout(this.qrTimer);
            this.qrTimer = null;
        }
        this.qrExpiresAt = null;
    }

    _markQrExpired(reason) {
        if (this.connectionStatus === 'qr_expired') return;
        this._clearQrTimer();
        this.qrExpired = false;
        this._pendingLink = false;
        this.connectionStatus = 'qr_expired';
        this.qrCode = null;
        console.log(`[${this.sessionId}] QR login expired (${reason}) - session revoked.`);

        wsManager.emitConnectionStatus(this.sessionId, 'qr_expired', { reason });
        wsManager.emitSessionStatus(this.sessionId, 'qr_expired', { reason });
        this._sendWebhook('connection.update', { status: 'qr_expired', reason });

        if (this.storeInterval) {
            clearInterval(this.storeInterval);
            this.storeInterval = null;
        }
        // Only wipe creds for an unpaired session; a paired one is never QR-expired.
        if (!this.registered) this.deleteAuthFolder();
    }

    _setupEventListeners(saveCreds) {
        // Connection update
        this.socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrCode = await qrcode.toDataURL(qr);
                this.connectionStatus = 'qr_ready';
                this._pendingLink = true;
                console.log(`📱 [${this.sessionId}] QR Code generated! Scan dengan WhatsApp Anda.`);

                // Emit QR code to WebSocket
                this._startQrExpiryTimer();
                wsManager.emitQRCode(this.sessionId, this.qrCode);
                wsManager.emitSessionStatus(this.sessionId, 'qr_ready', { qrExpiresAt: this.qrExpiresAt });
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.message;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const qrExpired =
                    !this.registered &&
                    (this.qrExpired ||
                        reason === 'QR refs attempts ended' ||
                        (statusCode === DisconnectReason.timedOut && !this.phoneNumber));

                console.log(`[${this.sessionId}] Connection closed:`, reason);

                if (qrExpired) {
                    this._markQrExpired(reason || 'QR expired');
                    return;
                }

                const wasConnected = this.connectionStatus === 'connected';
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                this.connectionStatus = shouldReconnect ? 'disconnected' : 'logged_out';
                this.qrCode = null;

                // Emit connection status to WebSocket
                wsManager.emitConnectionStatus(this.sessionId, 'disconnected', {
                    reason,
                    shouldReconnect
                });

                // Send webhook
                this._sendWebhook('connection.update', {
                    status: 'disconnected',
                    reason,
                    shouldReconnect
                });

                // Explicit lifecycle event: only when an account that WAS online went away.
                if (wasConnected) {
                    sessionEvents.onSessionDisconnected({
                        sessionId: this.sessionId,
                        phoneNumber: this.phoneNumber,
                        name: this.name,
                        username: this.metadata?.username || null,
                        reason: reason || null,
                        loggedOut: !shouldReconnect,
                        willReconnect: shouldReconnect
                    }, { sendWebhook: (event, data) => this._sendWebhook(event, data) });
                }
                wsManager.emitSessionStatus(this.sessionId, this.connectionStatus, {
                    reason: reason || null,
                    phoneNumber: this.phoneNumber,
                    name: this.name
                });

                if (shouldReconnect) {
                    // Rotate the egress proxy when the drop looks like a rate limit,
                    // or after repeated failures, so no account stays pinned to a bad IP.
                    this._proxyFailures++;
                    if (!this.proxy && proxyManager.size() > 1) {
                        const rateLimited = this._looksRateLimited(reason, statusCode);
                        if (rateLimited || this._proxyFailures >= 3) {
                            const next = proxyManager.rotate(this.sessionId, reason || `status ${statusCode}`);
                            this.activeProxy = next;
                            this._proxyFailures = 0;
                            console.log(
                                `[${this.sessionId}] Rotating proxy ` +
                                `(${rateLimited ? 'rate limit' : 'repeated failures'}) → ${redactProxyUrl(next)}`
                            );
                            wsManager.emitSessionStatus(this.sessionId, 'disconnected', {
                                proxyRotated: true,
                                proxy: redactProxyUrl(next),
                                reason: reason || null
                            });
                        }
                    }
                    console.log(`[${this.sessionId}] Reconnecting...`);
                    // Drop the dead socket and schedule a single reconnect so
                    // overlapping close events can't spawn duplicate sockets.
                    this._teardownSocket();
                    clearTimeout(this._reconnectTimer);
                    this._reconnectTimer = setTimeout(() => this.connect(), 5000);
                } else {
                    console.log(`[${this.sessionId}] Logged out.`);
                    wsManager.emitLoggedOut(this.sessionId);
                    this.deleteAuthFolder();
                }
            } else if (connection === 'open') {
                this._clearQrTimer();
                this.qrExpired = false;
                this._proxyFailures = 0; // healthy again — reset the rotation counter
                const justLinked = this._pendingLink;
                this._pendingLink = false;
                console.log(`[${this.sessionId}] WhatsApp Connected Successfully!`);
                this.connectionStatus = 'connected';
                this.qrCode = null;

                if (this.socket.user) {
                    this.phoneNumber = this.socket.user.id.split(':')[0];
                    this.name = this.socket.user.name || 'Unknown';
                    console.log(`👤 [${this.sessionId}] Connected as: ${this.name} (${this.phoneNumber})`);

                    // Register me JID, LID, and Phone Number
                    if (this.store) {
                        const normalizedMe = jidNormalizedUser(this.socket.user.id);
                        const meLid = this.socket.user.lid;
                        if (meLid) {
                            this.store.registerIdentity(meLid, normalizedMe, this.phoneNumber);
                        }
                    }
                }

                // Emit connection status to WebSocket
                wsManager.emitConnectionStatus(this.sessionId, 'connected', {
                    phoneNumber: this.phoneNumber,
                    name: this.name
                });

                // Send webhook
                this._sendWebhook('connection.update', {
                    status: 'connected',
                    phoneNumber: this.phoneNumber,
                    name: this.name
                });

                // Explicit lifecycle event (linked callback only on a fresh QR pair)
                sessionEvents.onSessionConnected(
                    {
                        sessionId: this.sessionId,
                        phoneNumber: this.phoneNumber,
                        name: this.name,
                        username: this.metadata?.username || null,
                        justLinked
                    },
                    { sendWebhook: (event, data) => this._sendWebhook(event, data) }
                );
                wsManager.emitSessionStatus(this.sessionId, 'connected', { phoneNumber: this.phoneNumber, name: this.name });

                // Chats can arrive keyed by @lid with no name - resolve to phone numbers
                // in the background so the chat list is readable.
                clearTimeout(this._lidResolveTimer1);
                clearTimeout(this._lidResolveTimer2);
                this._lidResolveTimer1 = setTimeout(() => this._resolvePendingLids().catch(() => {}), 6000);
                this._lidResolveTimer2 = setTimeout(() => this._resolvePendingLids().catch(() => {}), 20000);
            } else if (connection === 'connecting') {
                console.log(`🔄 [${this.sessionId}] Connecting to WhatsApp...`);
                this.connectionStatus = 'connecting';

                // Emit connection status to WebSocket
                wsManager.emitConnectionStatus(this.sessionId, 'connecting');
                wsManager.emitSessionStatus(this.sessionId, 'connecting');
            }
        });

        // Save credentials
        this.socket.ev.on('creds.update', saveCreds);

        // Messages upsert (new messages)
        this.socket.ev.on('messages.upsert', async (m) => {
            try {
                // Validate messages array
                if (!m?.messages || !Array.isArray(m.messages) || m.messages.length === 0) {
                    return;
                }

                const message = m.messages[0];

                // Validate message structure
                if (!message || !message.key || !message.key.remoteJid) {
                    console.log(`⚠️ [${this.sessionId}] Received invalid message structure, skipping`);
                    return;
                }

                // Media we sent from a local file: point the stored echo at that file.
                this._applyPendingMediaPath(message);

                if (!message.key.fromMe && m.type === 'notify') {
                    console.log(`📩 [${this.sessionId}] New message from:`, message.key.remoteJid);

                    // Auto-save media if present
                    await this._autoSaveMedia(message);

                    // Emit message to WebSocket
                    const formattedMessage = MessageFormatter.formatMessage(message, this.store);
                    wsManager.emitMessage(this.sessionId, formattedMessage);

                    // Send webhook
                    this._sendWebhook('message', formattedMessage);
                } else if (message.key.fromMe && m.type === 'notify') {
                    // Message sent confirmation
                    const formattedMessage = MessageFormatter.formatMessage(message, this.store);
                    wsManager.emitMessageSent(this.sessionId, formattedMessage);

                    // Send webhook
                    this._sendWebhook('message.sent', formattedMessage);
                }
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing message upsert:`, error.message);
            }
        });

        // Messages update (status: read, delivered, etc)
        this.socket.ev.on('messages.update', (updates) => {
            try {
                if (!updates || !Array.isArray(updates)) return;
                wsManager.emitMessageStatus(this.sessionId, updates);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing messages.update:`, error.message);
            }
        });

        // Message reaction
        this.socket.ev.on('messages.reaction', (reactions) => {
            try {
                if (!reactions) return;
                wsManager.emitToSession(this.sessionId, 'message.reaction', { reactions });
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing messages.reaction:`, error.message);
            }
        });

        // Chats upsert
        this.socket.ev.on('chats.upsert', (chats) => {
            try {
                if (!chats || !Array.isArray(chats)) return;
                console.log(`💬 [${this.sessionId}] Chats updated: ${chats.length} chats`);
                wsManager.emitChatsUpsert(this.sessionId, chats);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing chats.upsert:`, error.message);
            }
        });

        // Chats update
        this.socket.ev.on('chats.update', (chats) => {
            try {
                if (!chats || !Array.isArray(chats)) return;
                wsManager.emitChatUpdate(this.sessionId, chats);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing chats.update:`, error.message);
            }
        });

        // Chats delete
        this.socket.ev.on('chats.delete', (chatIds) => {
            try {
                if (!chatIds) return;
                wsManager.emitChatDelete(this.sessionId, chatIds);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing chats.delete:`, error.message);
            }
        });

        // Contacts upsert
        this.socket.ev.on('contacts.upsert', (contacts) => {
            try {
                if (!contacts || !Array.isArray(contacts)) return;
                console.log(`👥 [${this.sessionId}] Contacts updated: ${contacts.length} contacts`);
                wsManager.emitContactUpdate(this.sessionId, contacts);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing contacts.upsert:`, error.message);
            }
        });

        // Contacts update
        this.socket.ev.on('contacts.update', (contacts) => {
            try {
                if (!contacts || !Array.isArray(contacts)) return;
                wsManager.emitContactUpdate(this.sessionId, contacts);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing contacts.update:`, error.message);
            }
        });

        // Presence update (typing, online, etc)
        this.socket.ev.on('presence.update', (presence) => {
            try {
                if (!presence) return;
                wsManager.emitPresence(this.sessionId, presence);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing presence.update:`, error.message);
            }
        });

        // Group participants update
        this.socket.ev.on('group-participants.update', (update) => {
            try {
                if (!update) return;
                wsManager.emitGroupParticipants(this.sessionId, update);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing group-participants.update:`, error.message);
            }
        });

        // Groups update
        this.socket.ev.on('groups.update', (updates) => {
            try {
                if (!updates) return;
                wsManager.emitGroupUpdate(this.sessionId, updates);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing groups.update:`, error.message);
            }
        });

        // Call events
        this.socket.ev.on('call', (calls) => {
            try {
                if (!calls) return;
                wsManager.emitCall(this.sessionId, calls);
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing call:`, error.message);
            }
        });

        // Labels (for business accounts)
        this.socket.ev.on('labels.edit', (label) => {
            try {
                if (!label) return;
                wsManager.emitLabels(this.sessionId, { type: 'edit', label });
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing labels.edit:`, error.message);
            }
        });

        this.socket.ev.on('labels.association', (association) => {
            try {
                if (!association) return;
                wsManager.emitLabels(this.sessionId, { type: 'association', association });
            } catch (error) {
                console.error(`❌ [${this.sessionId}] Error processing labels.association:`, error.message);
            }
        });
    }

    getInfo() {
        const explicit = Boolean(this.proxy);
        const pm = proxyManager.info(this.sessionId);
        // The proxy the account actually connects through: the live one if up,
        // otherwise the explicit config or the account's current pool assignment.
        const activeUrl = this.activeProxy || this.proxy || (explicit ? this.proxy : pm.url);
        const required = explicit ? true : (pm.poolSize > 0 && pm.required);
        return {
            sessionId: this.sessionId,
            status: this.connectionStatus,
            isConnected: this.connectionStatus === 'connected',
            phoneNumber: this.phoneNumber,
            name: this.name,
            qrCode: this.qrCode,
            qrExpiresAt: this.qrExpiresAt,
            storeStats: this.store ? this.store.getStats() : null,
            metadata: this.metadata,
            webhooks: this.webhooks,
            proxy: redactProxyUrl(activeUrl),
            proxyInfo: {
                active: redactProxyUrl(activeUrl),
                connected: this.connectionStatus === 'connected' && Boolean(this.activeProxy),
                source: explicit ? 'session' : (pm.poolSize > 0 ? 'pool' : 'none'),
                required,
                poolSize: pm.poolSize,
                index: explicit ? null : pm.index,
                rotations: explicit ? 0 : pm.rotations,
                rotatedAt: explicit ? null : pm.rotatedAt,
                lastReason: explicit ? null : pm.lastReason
            },
            sync: this.store ? this.store.syncState : null
        };
    }

    async logout() {
        try {
            this._clearQrTimer();
            clearTimeout(this._proxyRetryTimer);
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
            if (this.storeInterval) {
                clearInterval(this.storeInterval);
            }

            // Clear store and delete all media files
            if (this.store) {
                this.store.clear();
            }

            // Delete media folder for this session
            this.deleteMediaFolder();

            if (this.socket) {
                await this.socket.logout();
                this.socket = null;
            }
            this.deleteAuthFolder();
            proxyManager.release(this.sessionId); // free the pool assignment
            this.activeProxy = null;
            this.connectionStatus = 'disconnected';
            this.qrCode = null;
            this.phoneNumber = null;
            this.name = null;
            return { success: true, message: 'Logged out successfully' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    deleteAuthFolder() {
        try {
            if (fs.existsSync(this.authFolder)) {
                fs.rmSync(this.authFolder, { recursive: true, force: true });
                console.log(`🗑️ [${this.sessionId}] Auth folder deleted`);
            }
        } catch (error) {
            console.error(`[${this.sessionId}] Error deleting auth folder:`, error);
        }
    }

    deleteMediaFolder() {
        try {
            if (fs.existsSync(this.mediaFolder)) {
                fs.rmSync(this.mediaFolder, { recursive: true, force: true });
                console.log(`🗑️ [${this.sessionId}] Media folder deleted`);
            }
        } catch (error) {
            console.error(`[${this.sessionId}] Error deleting media folder:`, error);
        }
    }

    getSocket() {
        return this.socket;
    }

    // ==================== HELPERS ====================

    formatPhoneNumber(phone, isGroup = null) {
        if (!phone || phone.trim() === '') {
            throw new Error('Phone number cannot be empty');
        }
        if (phone.includes('@')) {
            if (phone.includes('@g.us')) {
                return phone.replace('@c.us', '@g.us');
            }
            return phone;
        }
        let formatted = phone.replace(/\D/g, '');
        if (formatted.startsWith('0')) {
            formatted = '62' + formatted.slice(1);
        }
        if (!formatted) {
            throw new Error('Invalid phone number: no digits found');
        }
        if (isGroup === null) {
            isGroup = this.isGroupId(phone);
        }
        return isGroup ? `${formatted}@g.us` : `${formatted}@c.us`;
    }

    formatJid(id, isGroup = false) {
        if (id.includes('@')) return id;

        let formatted = id.replace(/\D/g, '');
        if (formatted.startsWith('0')) {
            formatted = '62' + formatted.slice(1);
        }

        return isGroup ? `${formatted}@g.us` : `${formatted}@c.us`;
    }

    formatChatId(chatId, isGroup = null) {
        if (!chatId || chatId.trim() === '') {
            throw new Error('Chat ID cannot be empty');
        }
        if (chatId.includes('@')) {
            if (chatId.includes('@g.us')) {
                return chatId.replace('@c.us', '@g.us');
            }
            return chatId;
        }

        let formatted = chatId.replace(/\D/g, '');
        if (formatted.startsWith('0')) {
            formatted = '62' + formatted.slice(1);
        }
        if (!formatted) {
            throw new Error('Invalid Chat ID: no digits found');
        }
        if (isGroup === null) {
            isGroup = this.isGroupId(chatId);
        }
        return isGroup ? `${formatted}@g.us` : `${formatted}@c.us`;
    }

    normalizeChatId(chatId) {
        if (!chatId || chatId.trim() === '') {
            return null;
        }
        if (chatId.includes('@g.us')) {
            return this.formatChatId(chatId, true);
        }
        if (chatId.includes('@c.us')) {
            return this.formatChatId(chatId, false);
        }
        const jid = this.formatJid(chatId, false);
        if (this.isGroupJid(jid)) {
            return this.formatChatId(chatId, true);
        }
        return jid;
    }

    isGroupJid(jid) {
        return jid?.endsWith('@g.us');
    }

    isGroupId(chatId) {
        return chatId.includes('@g.us');
    }

    /**
     * Normalize a phone JID to the @c.us suffix used throughout the gateway.
     */
    normalizePhoneJid(jid) {
        if (!jid) return jid;
        if (jid.endsWith('@s.whatsapp.net')) {
            return `${jid.split('@')[0]}@c.us`;
        }
        return jid;
    }

    /**
     * Extract a bare phone number (digits only) from any phone representation:
     * a full PN JID ("919876543210@s.whatsapp.net"), a device-specific JID
     * ("919876543210:3@s.whatsapp.net"), or already-bare digits ("919876543210").
     * Returns null for LID JIDs or anything without real digits.
     */
    _extractPhoneDigits(value) {
        if (value == null) return null;
        const str = String(value);
        // A LID is not a phone number — never treat it as one.
        if (str.endsWith('@lid') || str.endsWith('@hosted.lid')) return null;
        const digits = str.split('@')[0].split(':')[0].replace(/\D/g, '');
        return digits.length ? digits : null;
    }

    /**
     * Parse a device-specific PN JID (e.g. "628123456789:0@s.whatsapp.net") into
     * a clean phone number and a normalized @c.us JID.
     */
    _parsePnJid(pnJid) {
        if (!pnJid) return null;
        const userPart = pnJid.split('@')[0];
        if (!userPart) return null;
        const phone = userPart.split(':')[0];
        if (!phone || !/^\d+$/.test(phone)) return null;
        const jid = `${phone}@c.us`;
        return { jid, pn: phone };
    }

    /**
     * Heuristic: does this disconnect reason / status look like WhatsApp rate
     * limiting the current egress IP? Used to trigger proxy rotation.
     */
    _looksRateLimited(reason, statusCode) {
        const RATE_LIMIT_STATUS = new Set([408, 429, 503]);
        if (RATE_LIMIT_STATUS.has(Number(statusCode))) return true;
        return /rate.?over.?limit|rate.?limit|over.?limit|too.?many|429|throttl/i.test(String(reason || ''));
    }

    /**
     * Called when a network operation (e.g. USync LID resolution) is rate-limited.
     * Rotates this account onto a fresh proxy and reconnects so subsequent queries
     * leave through a different IP. Debounced and only when a pool is available.
     */
    _maybeRotateOnRateLimit(reason = 'rate-overlimit') {
        if (this.proxy || proxyManager.size() <= 1) return; // sticky/explicit or nothing to rotate to
        const now = Date.now();
        if (now < this._nextProxyRotateAt) return; // debounce back-to-back rotations
        this._nextProxyRotateAt = now + 60_000;
        const next = proxyManager.rotate(this.sessionId, reason);
        this.activeProxy = next;
        console.log(`[${this.sessionId}] Rotating proxy after ${reason} → ${redactProxyUrl(next)}; reconnecting`);
        wsManager.emitSessionStatus(this.sessionId, this.connectionStatus, {
            proxyRotated: true,
            proxy: redactProxyUrl(next),
            reason
        });
        // Soft reconnect so the new proxy applies to future socket traffic.
        this.restart(`proxy rotation after ${reason}`).catch(() => {});
    }

    // USync directory queries are rate-limited by WhatsApp. We therefore resolve
    // LIDs in ONE batched query per request (and only after a failure-backoff,
    // or we keep re-hitting `rate-overlimit` and never resolve anything).
    //
    // Resolution order for every LID:
    //   1. Gateway's own in-memory lidMap cache (no network)
    //   2. Baileys' persistent LID-PN mapping store (no network)
    //   3. ONE batched USync query for whatever is still unmapped

    /** Resolve one LID without network access (cache + signal repository only). */
    async _resolveLidLocally(lid) {
        if (!lid || !lid.endsWith('@lid') || !this.socket) return null;
        const lowerLid = lid.toLowerCase();

        // 1. Gateway cache
        const cached = this.store?.resolveIdentity(lowerLid);
        if (cached?.jid) {
            const parsed = this._parsePnJid(this.normalizePhoneJid(cached.jid));
            if (parsed) return parsed;
        }

        // 2. Baileys' persistent LID mapping store (populated by message/group traffic)
        const signalMapping = this.socket.signalRepository?.lidMapping;
        if (signalMapping?.getPNForLID) {
            try {
                const pnJid = await signalMapping.getPNForLID(lowerLid);
                const parsed = this._parsePnJid(pnJid);
                if (parsed) {
                    this.store?.registerIdentity(lowerLid, parsed.jid);
                    return parsed;
                }
            } catch (e) {
                // ignore
            }
        }
        return null;
    }

    /**
     * Resolve many LIDs with ONE batched USync query.
     * Local sources are checked first; only unmapped LIDs go over the wire.
     * Returns a Map of lid -> { jid, pn }.
     */
    async _resolveLidsBatch(lids) {
        const out = new Map();
        if (!lids.length || !this.socket) return out;

        const leftovers = [];
        for (const lid of lids) {
            const local = await this._resolveLidLocally(lid);
            if (local) out.set(lid.toLowerCase(), local);
            else leftovers.push(lid.toLowerCase());
        }
        if (leftovers.length === 0) return out;

        // Cool down after a failed/rate-limited batch: a repeat request inside the
        // window is what triggers `rate-overlimit` and keeps everything unresolved.
        const now = Date.now();
        if (now < this._usyncCooldownUntil) return out;

        try {
            const { USyncQuery, USyncUser } = require('@whiskeysockets/baileys');
            const query = new USyncQuery()
                .withContext('message')
                .withDeviceProtocol()
                .withLIDProtocol();

            // All LIDs go into a single directory request.
            for (const lid of leftovers) query.withUser(new USyncUser().withId(lid));

            const result = await this.socket.executeUSyncQuery(query);
            if (result && result.list) {
                for (const item of result.list) {
                    if (!item.lid || !item.id) continue;
                    const lidJid = item.lid.toLowerCase();
                    const pnJid = item.id.toLowerCase();
                    this.store?.registerIdentity(lidJid, pnJid);
                    const parsed = this._parsePnJid(this.normalizePhoneJid(pnJid));
                    if (parsed) out.set(lidJid, parsed);
                }
            }
        } catch (error) {
            // rate-overlimit / timeout — back off for a while so the UI doesn't spam.
            this._usyncCooldownUntil = Date.now() + 30_000;
            console.error(`[${this.sessionId}] Batch LID resolution failed (cooling down for 30s):`, error.message);
            // If WhatsApp is throttling this egress IP, move the account to a fresh
            // proxy so the next round of directory lookups can actually succeed.
            if (this._looksRateLimited(error.message)) {
                this._maybeRotateOnRateLimit('LID resolve rate-overlimit');
            }
        }
        return out;
    }

    /** Single-LID convenience wrapper around _resolveLidsBatch. */
    async _resolveLidToPhone(lid) {
        const out = await this._resolveLidsBatch([lid]);
        return out.get(lid?.toLowerCase()) || null;
    }

    /**
     * Send a message and record the LID↔phone identity for the recipient.
     *
     * ROOT FIX for outbound-only chats: this gateway sends to phone numbers, but
     * WhatsApp v7 keys the resulting chat/messages by the recipient's @lid. Unless
     * we capture the mapping at send time, that chat can only ever display the raw
     * LID (there is no phone number anywhere in the stored outbound message).
     * Here we always know the phone JID we sent to, so we bind it to the LID that
     * Baileys used — both from the send result and from the signal LID store.
     */
    async _sendAndTrack(jid, content, options) {
        const result = await this.socket.sendMessage(jid, content, options);
        try { this._recordSentIdentity(jid, result); } catch (_) { /* non-fatal */ }
        // Debounced re-sweep: applies any newly-learned LID↔phone mappings to
        // still-pending legacy @lid chats and refreshes the chat list.
        this._scheduleLidResweep();
        return result;
    }

    /** Debounced background re-run of LID resolution after send activity. */
    _scheduleLidResweep() {
        clearTimeout(this._lidResweepTimer);
        this._lidResweepTimer = setTimeout(() => {
            this._resolvePendingLids().catch(() => {});
        }, 4000);
    }

    _recordSentIdentity(jid, result) {
        if (!this.store || !jid) return;
        // Only phone-number recipients carry a resolvable identity (skip groups).
        if (jid.endsWith('@g.us') || jid.endsWith('@lid')) return;
        const pnJid = this.normalizePhoneJid(jid); // canonical @c.us form

        // 1. The send result itself may be keyed by the recipient's LID.
        const rjid = result?.key?.remoteJid;
        const ralt = result?.key?.remoteJidAlt;
        if (rjid && rjid.endsWith('@lid')) {
            this.store.registerIdentity(rjid, pnJid);
        }
        if (ralt && ralt.endsWith('@lid')) {
            this.store.registerIdentity(ralt, pnJid);
        }

        // 2. Ask Baileys' signal LID store for the LID it used for this phone and
        //    bind that too, so the chat (keyed by LID) resolves to the number.
        const lidMapping = this.socket?.signalRepository?.lidMapping;
        if (lidMapping?.getLIDForPN) {
            Promise.resolve()
                .then(() => lidMapping.getLIDForPN(pnJid))
                .then((lid) => {
                    if (lid && String(lid).endsWith('@lid')) {
                        this.store.registerIdentity(String(lid).toLowerCase(), pnJid);
                        this.store._invalidateOverviewCache?.();
                    }
                })
                .catch(() => {});
        }
    }

    /**
     * Resolve a chat identifier to a stable JID and phone number.
     * Local sources only — the batched resolution happens in `_resolveLidsBatch`.
     */
    async _resolveChatIdentity(chatId) {
        if (!chatId) return { id: chatId, phone: null, isGroup: false };
        if (this.isGroupJid(chatId)) return { id: chatId, phone: null, isGroup: true };

        if (chatId.endsWith('@lid')) {
            const resolved = await this._resolveLidLocally(chatId);
            if (resolved) return { id: resolved.jid, phone: resolved.pn, isGroup: false };
            return { id: chatId, phone: null, isGroup: false };
        }

        // Already a phone JID: just normalize the suffix
        if (chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@c.us')) {
            const normalized = this.normalizePhoneJid(chatId);
            return { id: normalized, phone: normalized.split('@')[0], isGroup: false };
        }

        return { id: chatId, phone: null, isGroup: false };
    }

    async resolveLidFromServer(lid) {
        // Kept for backward compatibility.
        const parsed = await this._resolveLidToPhone(lid);
        if (!parsed) return null;
        return { lid: lid.toLowerCase(), jid: parsed.jid, pn: parsed.pn };
    }

    /**
     * Resolve chats/messages keyed by @lid (WhatsApp privacy IDs) to real phone
     * JIDs so the chat list shows numbers/names instead of raw LIDs. Runs in the
     * background after connect.
     */
    async _resolvePendingLids(max = 80) {
        if (!this.store || !this.socket || this.connectionStatus !== 'connected') return;

        // STEP 0 (no network): build LID→phone mappings from Baileys' signal LID
        // store using every phone number we already know. Outbound-only chats have
        // no phone data locally, but the signal store often already knows the LID
        // for a phone we've messaged — this resolves them without any USync query.
        const reverseResolved = await this._resolveLidsFromSignalStore();

        const pending = new Set();
        const collect = (id) => {
            if (id && id.endsWith('@lid') && !this.store.resolveIdentity(id)) pending.add(id);
        };
        for (const id of this.store.messages.keys()) collect(id);
        for (const id of this.store.chats.keys()) collect(id);
        for (const id of this.store.contacts.keys()) collect(id);
        const lids = [...pending].slice(0, max);
        if (lids.length === 0) {
            if (reverseResolved > 0) {
                this.store._invalidateOverviewCache?.();
                this.store._invalidateContactsCache?.();
            }
            return;
        }
        console.log(`[${this.sessionId}] resolving ${lids.length} LID mapping(s)...`);
        // ONE batched USync query (plus local sources) instead of N individual queries.
        const batch = await this._resolveLidsBatch(lids);
        const resolved = batch.size + reverseResolved;
        if (resolved > 0) {
            this.store._invalidateOverviewCache?.();
            this.store._invalidateContactsCache?.();
            console.log(`[${this.sessionId}] resolved ${resolved}/${lids.length} LID mapping(s)`);
        }
    }

    /**
     * Populate LID→phone mappings from Baileys' persistent signal LID store using
     * the phone numbers we already have (contacts + phone-keyed chats). No network.
     * Returns the number of new mappings registered.
     */
    async _resolveLidsFromSignalStore() {
        const lidMapping = this.socket?.signalRepository?.lidMapping;
        if (!lidMapping?.getLIDForPN) return 0;

        // Collect candidate phone JIDs from contacts and phone-keyed chats/messages.
        const phoneJids = new Set();
        const addIfPhone = (id) => {
            if (id && (id.endsWith('@s.whatsapp.net') || id.endsWith('@c.us'))) {
                phoneJids.add(id);
            }
        };
        for (const id of this.store.contacts.keys()) addIfPhone(id);
        for (const id of this.store.chats.keys()) addIfPhone(id);
        for (const id of this.store.messages.keys()) addIfPhone(id);

        let count = 0;
        for (const pnJid of phoneJids) {
            try {
                const lid = await lidMapping.getLIDForPN(pnJid);
                if (lid && String(lid).endsWith('@lid')) {
                    const lowerLid = String(lid).toLowerCase();
                    if (!this.store.resolveIdentity(lowerLid)) {
                        this.store.registerIdentity(lowerLid, pnJid);
                        count++;
                    }
                }
            } catch (_) { /* ignore individual failures */ }
        }
        if (count > 0) {
            console.log(`[${this.sessionId}] resolved ${count} LID mapping(s) from signal store`);
        }
        return count;
    }

    // ==================== SEND MESSAGES ====================

    /**
     * Send presence update (typing indicator)
     * @param {string} chatId - Chat ID
     * @param {string} presence - 'composing' | 'recording' | 'paused'
     */
    async sendPresenceUpdate(chatId, presence = 'composing') {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);
            await this.socket.sendPresenceUpdate(presence, jid);

            return { success: true, message: `Presence '${presence}' sent` };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Helper: Send typing indicator and wait
     * @param {string} jid - Formatted JID
     * @param {number} typingTime - Time in milliseconds to show typing
     */
    async _simulateTyping(jid, typingTime = 0) {
        if (typingTime > 0) {
            await this.socket.sendPresenceUpdate('composing', jid);
            await new Promise(resolve => setTimeout(resolve, typingTime));
            await this.socket.sendPresenceUpdate('paused', jid);
        }
    }

    async sendTextMessage(chatId, message, typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Simulate typing if typingTime > 0
            await this._simulateTyping(jid, typingTime);

            const messageContent = { text: message };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                // Try to get the message from store first
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    // Fallback: create minimal quoted structure
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);

            return {
                success: true,
                message: 'Message sent successfully',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async sendImage(chatId, imageUrl, caption = '', typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Simulate typing if typingTime > 0
            await this._simulateTyping(jid, typingTime);

            const messageContent = {
                image: { url: this._resolveMediaUrl(imageUrl) },
                caption: caption
            };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);
            this._rememberOutgoingMedia(jid, result.key.id, imageUrl);

            return {
                success: true,
                message: 'Image sent successfully',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async sendDocument(chatId, documentUrl, filename, mimetype = 'application/pdf', caption = '', typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Simulate typing if typingTime > 0
            await this._simulateTyping(jid, typingTime);

            const messageContent = {
                document: { url: this._resolveMediaUrl(documentUrl) },
                fileName: filename,
                mimetype: mimetype,
                caption: caption || undefined
            };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);
            this._rememberOutgoingMedia(jid, result.key.id, documentUrl);

            return {
                success: true,
                message: 'Document sent successfully',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Send Audio Message
     * @param {string} chatId - Chat ID or phone number
     * @param {string} audioUrl - URL to audio file (must be OGG format)
     * @param {boolean} ptt - Push to talk (voice note) mode
     * @param {number} typingTime - Typing simulation time in ms
     * @param {string} replyTo - Message ID to reply to
     */
    async sendVideo(chatId, videoUrl, caption = '', typingTime = 0, replyTo = null, gifPlayback = false) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }
            const jid = this.formatChatId(chatId);
            await this._simulateTyping(jid, typingTime);
            const messageContent = { video: { url: this._resolveMediaUrl(videoUrl) }, caption, gifPlayback: Boolean(gifPlayback) };
            const messageOptions = {};
            if (replyTo) {
                messageOptions.quoted = this.store?.getMessage(jid, replyTo) || {
                    key: { remoteJid: jid, id: replyTo, fromMe: false }, message: { conversation: '' }
                };
            }
            const result = await this._sendAndTrack(jid, messageContent, messageOptions);
            this._rememberOutgoingMedia(jid, result.key.id, videoUrl);
            return { success: true, message: 'Video sent successfully', data: { messageId: result.key.id, chatId: jid, timestamp: new Date().toISOString() } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Send a file uploaded to this server. The WhatsApp message kind is picked
     * from the mimetype: image / video / audio / document.
     */
    async sendMedia(chatId, file, opts = {}) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }
            if (!file || !file.url) return { success: false, message: 'No file to send' };
            const { caption = '', typingTime = 0, replyTo = null, ptt = false, asDocument = false } = opts;
            const mimetype = (file.mimetype || 'application/octet-stream').toLowerCase();
            const source = this._resolveMediaUrl(file.url);
            const jid = this.formatChatId(chatId);
            await this._simulateTyping(jid, typingTime);

            let kind, messageContent;
            if (!asDocument && mimetype.startsWith('image/') && mimetype !== 'image/webp') {
                kind = 'image'; messageContent = { image: { url: source }, caption };
            } else if (!asDocument && mimetype.startsWith('video/')) {
                kind = 'video'; messageContent = { video: { url: source }, caption };
            } else if (!asDocument && mimetype.startsWith('audio/')) {
                kind = ptt ? 'ptt' : 'audio'; messageContent = { audio: { url: source }, mimetype, ptt: Boolean(ptt) };
            } else {
                kind = 'document';
                messageContent = { document: { url: source }, mimetype, fileName: file.filename || path.basename(source), caption };
            }
            const messageOptions = {};
            if (replyTo) {
                messageOptions.quoted = this.store?.getMessage(jid, replyTo) || {
                    key: { remoteJid: jid, id: replyTo, fromMe: false }, message: { conversation: '' }
                };
            }
            const result = await this._sendAndTrack(jid, messageContent, messageOptions);
            this._rememberOutgoingMedia(jid, result.key.id, file.url);
            return {
                success: true, message: `${kind} sent successfully`,
                data: { messageId: result.key.id, chatId: jid, type: kind, mediaUrl: file.url, mimetype, filename: file.filename || null, caption: caption || null, timestamp: new Date().toISOString() }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /** Ensure a message's media is on disk and return its URL (downloads on first request). */
    async getMessageMedia(chatId, messageId) {
        try {
            if (!this.store) return { success: false, message: 'Session store not ready' };
            const jid = this.formatChatId(chatId);
            const msg = this.store.getMessage(jid, messageId) || this.store.getMessage(chatId, messageId);
            if (!msg) return { success: false, message: "Message not found in this session's history" };

            const contentType = msg.message ? getContentType(msg.message) : null;
            const mediaContent = contentType ? msg.message[contentType] : null;
            if (!mediaContent || !['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(contentType)) {
                return { success: false, message: 'Message has no media' };
            }
            let relativePath = msg._mediaPath || null;
            const onDisk = relativePath && fs.existsSync(msg._mediaLocalPath || path.join(process.cwd(), 'public', relativePath));
            if (!onDisk) {
                if (!this.socket || this.connectionStatus !== 'connected') {
                    return { success: false, message: 'Session not connected - cannot download media' };
                }
                relativePath = await this._autoSaveMedia(msg, { force: true });
                if (!relativePath) return { success: false, message: 'Media could not be downloaded (it may have expired on WhatsApp)' };
            }
            return {
                success: true,
                data: { messageId, chatId: jid, url: relativePath, mimetype: mediaContent.mimetype || this._getMimetype(contentType), filename: mediaContent.fileName || path.basename(relativePath), size: Number(mediaContent.fileLength) || null }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /** `/media/...` -> absolute file path Baileys can stream; anything else untouched. */
    _resolveMediaUrl(url) {
        if (typeof url === 'string' && url.startsWith('/media/')) {
            const clean = decodeURIComponent(url.split('?')[0]);
            const abs = path.join(process.cwd(), 'public', clean);
            const root = path.join(process.cwd(), 'public', 'media');
            if (!abs.startsWith(root)) throw new Error('Invalid media path');
            return abs;
        }
        return url;
    }

    _rememberOutgoingMedia(jid, messageId, url) {
        if (!messageId || typeof url !== 'string' || !url.startsWith('/media/')) return;
        const clean = url.split('?')[0];
        const localPath = path.join(process.cwd(), 'public', decodeURIComponent(clean));
        const stored = this.store?.getMessage(jid, messageId);
        if (stored) {
            stored._mediaPath = clean;
            stored._mediaLocalPath = localPath;
        } else {
            this._pendingMediaPaths.set(messageId, { relativePath: clean, localPath });
        }
        if (this.store) this.store.registerMediaFile(messageId, localPath);
    }

    _applyPendingMediaPath(message) {
        const id = message?.key?.id;
        if (!id || !this._pendingMediaPaths.has(id)) return;
        const { relativePath, localPath } = this._pendingMediaPaths.get(id);
        this._pendingMediaPaths.delete(id);
        message._mediaPath = relativePath;
        message._mediaLocalPath = localPath;
        const stored = this.store?.getMessage(message.key.remoteJid, id);
        if (stored && stored !== message) {
            stored._mediaPath = relativePath;
            stored._mediaLocalPath = localPath;
        }
    }

    async sendAudio(chatId, audioUrl, ptt = false, typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            // Validate OGG format
            const urlLower = audioUrl.toLowerCase();
            if (!urlLower.endsWith('.ogg') && !urlLower.includes('.ogg?')) {
                return {
                    success: false,
                    message: 'Audio must be in OGG format (.ogg). WhatsApp only supports OGG audio files.'
                };
            }

            const jid = this.formatChatId(chatId);

            // Simulate recording if typingTime > 0
            if (typingTime > 0) {
                await this.socket.sendPresenceUpdate('recording', jid);
                await new Promise(resolve => setTimeout(resolve, typingTime));
                await this.socket.sendPresenceUpdate('paused', jid);
            }

            const messageContent = {
                audio: { url: this._resolveMediaUrl(audioUrl) },
                ptt: ptt, // true = voice note, false = audio file
                mimetype: 'audio/ogg; codecs=opus'
            };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);

            return {
                success: true,
                message: ptt ? 'Voice note sent successfully' : 'Audio sent successfully',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async sendLocation(chatId, latitude, longitude, name = '', typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Simulate typing if typingTime > 0
            await this._simulateTyping(jid, typingTime);

            const messageContent = {
                location: {
                    degreesLatitude: latitude,
                    degreesLongitude: longitude,
                    name: name
                }
            };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);

            return {
                success: true,
                message: 'Location sent successfully',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async sendContact(chatId, contactName, contactPhone, typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Simulate typing if typingTime > 0
            await this._simulateTyping(jid, typingTime);

            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE;waid=${contactPhone}:+${contactPhone}\nEND:VCARD`;

            const messageContent = {
                contacts: {
                    displayName: contactName,
                    contacts: [{ vcard }]
                }
            };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);

            return {
                success: true,
                message: 'Contact sent successfully',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Send Button Message
     * NOTE: Regular button messages are DEPRECATED by WhatsApp since 2022.
     * This method now uses Poll as an alternative for interactive choices.
     * If you need actual buttons, you must use WhatsApp Business API (Cloud API).
     */
    async sendButton(chatId, text, footer, buttons, typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Simulate typing if typingTime > 0
            await this._simulateTyping(jid, typingTime);

            // WhatsApp deprecated regular buttons in 2022
            // Using Poll as an alternative for interactive choices
            const pollName = footer ? `${text}\n\n${footer}` : text;

            const messageContent = {
                poll: {
                    name: pollName,
                    values: buttons, // Poll options as choices
                    selectableCount: 1 // Single selection like a button
                }
            };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);

            return {
                success: true,
                message: 'Interactive poll sent (buttons are deprecated by WhatsApp)',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString(),
                    note: 'WhatsApp deprecated button messages in 2022. Poll is used as alternative.'
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Send Poll Message
     * A working alternative for interactive choices
     */
    async sendPoll(chatId, question, options, selectableCount = 1, typingTime = 0, replyTo = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Simulate typing if typingTime > 0
            await this._simulateTyping(jid, typingTime);

            const messageContent = {
                poll: {
                    name: question,
                    values: options,
                    selectableCount: selectableCount
                }
            };
            const messageOptions = {};

            // Add quoted message for reply
            if (replyTo) {
                const quotedMsg = this.store?.getMessage(jid, replyTo);
                if (quotedMsg) {
                    messageOptions.quoted = quotedMsg;
                } else {
                    messageOptions.quoted = {
                        key: {
                            remoteJid: jid,
                            id: replyTo,
                            fromMe: false
                        },
                        message: { conversation: '' }
                    };
                }
            }

            const result = await this._sendAndTrack(jid, messageContent, messageOptions);

            return {
                success: true,
                message: 'Poll sent successfully',
                data: {
                    messageId: result.key.id,
                    chatId: jid,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== CONTACT & PROFILE ====================

    async isRegistered(phone) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatPhoneNumber(phone);
            const [result] = await this.socket.onWhatsApp(jid.replace('@c.us', ''));

            return {
                success: true,
                data: {
                    phone: phone,
                    isRegistered: !!result?.exists,
                    jid: result?.jid || null
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async getProfilePicture(phone) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatPhoneNumber(phone);
            const ppUrl = await this.socket.profilePictureUrl(jid, 'image');

            return {
                success: true,
                data: {
                    phone: phone,
                    profilePicture: ppUrl
                }
            };
        } catch (error) {
            return {
                success: true,
                data: {
                    phone: phone,
                    profilePicture: null
                }
            };
        }
    }

    async getContactInfo(phone) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatPhoneNumber(phone);

            let profilePicture = null;
            try {
                profilePicture = await this.socket.profilePictureUrl(jid, 'image');
            } catch (e) {}

            let status = null;
            try {
                const statusResult = await this.socket.fetchStatus(jid);
                status = statusResult?.status || null;
            } catch (e) {}

            let isRegistered = false;
            try {
                const [result] = await this.socket.onWhatsApp(jid.replace('@c.us', ''));
                isRegistered = !!result?.exists;
            } catch (e) {}

            return {
                success: true,
                data: {
                    phone: phone,
                    jid: jid,
                    isRegistered: isRegistered,
                    profilePicture: profilePicture,
                    status: status
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== SCRAPERS & ADDRESS BOOK ====================

    async scrapeContacts(opts = {}) {
        try {
            if (!this.store) return { success: false, message: 'Store not initialized' };
            const { data } = this.store.getContactsFast({ limit: Number.MAX_SAFE_INTEGER, offset: 0, search: '' });
            const contacts = data.map((c) => ({
                jid: c.id,
                phone: c.id.split('@')[0],
                name: c.name || null,
                pushName: c.notify || null,
                verifiedName: c.verifiedName || null,
                profilePicture: opts.includeProfilePicture ? c.profilePicture || null : undefined,
                sessionId: this.sessionId,
                accountName: this.name || this.sessionId,
                accountPhone: this.phoneNumber || null
            }));
            return { success: true, data: { total: contacts.length, contacts } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async scrapeGroupContacts(groupIds = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }
            let targets;
            if (Array.isArray(groupIds) && groupIds.length > 0) {
                targets = groupIds.map((g) => this.formatJid(g, true));
            } else {
                const all = await this.socket.groupFetchAllParticipating();
                targets = Object.keys(all);
            }

            const groups = [];
            const errors = [];
            const participantRows = [];

            // 1. Fetch metadata for all targets first
            for (const gid of targets) {
                let metadata;
                try {
                    metadata = await this.socket.groupMetadata(gid);
                } catch (e) {
                    errors.push({ groupId: gid, error: e.message });
                    continue;
                }
                groups.push({ id: metadata.id, name: metadata.subject, participantsCount: metadata.participants.length });
                for (const part of metadata.participants) {
                    participantRows.push({ part, groupId: metadata.id, groupName: metadata.subject });
                }
            }

            // 2. Resolve LID participants.
            //    - groupMetadata already includes `phoneNumber` for many LID participants;
            //      we use that directly and store the mapping.
            //    - For any remaining uncached LIDs we fall back to the persistent LID-PN
            //      mapping store and, as a last resort, a bounded USync query.
            const contacts = [];
            const unresolvedLids = [];
            for (const { part, groupId, groupName } of participantRows) {
                let jid = part.id;
                let phone = null;

                if (jid.endsWith('@lid')) {
                    // groupMetadata already exposes the real number for most LID
                    // participants via `phoneNumber`. Baileys returns it as a full PN
                    // JID (e.g. "919876543210@s.whatsapp.net"), so we must strip the
                    // suffix to get the digits — a bare /^\d+$/ test on the JID always
                    // fails and (previously) pushed everything into the rate-limited
                    // USync path, leaving only raw LIDs.
                    const pnDigits = this._extractPhoneDigits(part.phoneNumber);
                    if (pnDigits) {
                        phone = pnDigits;
                        jid = `${phone}@c.us`;
                        this.store?.registerIdentity(part.id, jid);
                        // Also persist in Baileys' LID mapping store for other code paths
                        const lidMapping = this.socket.signalRepository?.lidMapping;
                        if (lidMapping?.storeLIDPNMappings) {
                            lidMapping.storeLIDPNMappings([{ lid: part.id, pn: `${phone}@s.whatsapp.net` }]).catch(() => {});
                        }
                    } else {
                        // Try cache / signal repository / USync
                        const resolved = this.store ? this.store.resolveIdentity(jid) : null;
                        if (resolved?.jid) {
                            jid = this.normalizePhoneJid(resolved.jid);
                            phone = jid.split('@')[0];
                        } else {
                            unresolvedLids.push(jid);
                        }
                    }
                } else if (jid.endsWith('@c.us') || jid.endsWith('@s.whatsapp.net')) {
                    phone = jid.split('@')[0];
                }

                const known = this.store ? this.store.getContact(jid) : null;
                contacts.push({
                    jid,
                    phone,
                    name: (known && (known.name || known.notify)) || null,
                    admin: part.admin || null,
                    groupId,
                    groupName,
                    sessionId: this.sessionId,
                    accountName: this.name || this.sessionId
                });
            }

            if (unresolvedLids.length) {
                // ONE batched USync query for all remaining unresolved LIDs.
                const batch = await this._resolveLidsBatch([...new Set(unresolvedLids)]);
                // Patch any rows we already built that are still unresolved.
                for (const row of contacts) {
                    if (row.phone || !row.jid.endsWith('@lid')) continue;
                    const hit = batch.get(row.jid) || this.store?.resolveIdentity(row.jid);
                    if (hit?.jid) {
                        row.jid = this.normalizePhoneJid(hit.jid);
                        row.phone = hit.pn || row.jid.split('@')[0];
                        const known = this.store?.getContact(row.jid);
                        if (known?.name || known?.notify) row.name = known.name || known.notify;
                    }
                }
            }

            return { success: true, data: { groups, contacts, errors: errors.length ? errors : undefined } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async saveContact(phone, name = '') {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }
            const jid = this.formatJid(phone, false);
            const displayName = (name && name.trim()) || jid.split('@')[0];
            if (typeof this.socket.addOrEditContact !== 'function') {
                return { success: false, message: 'This Baileys build cannot save contacts' };
            }
            await this.socket.addOrEditContact(jid, {
                fullName: displayName,
                firstName: displayName,
                saveOnPrimaryAddressbook: true,
                pnJid: jid
            });
            if (this.store) {
                const existing = this.store.contacts.get(jid) || { id: jid };
                this.store.contacts.set(jid, { ...existing, id: jid, name: displayName });
            }
            return { success: true, message: 'Contact saved', data: { jid, phone: jid.split('@')[0], name: displayName } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async addContactToGroup(groupId, phone, name = '') {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }
            if (!groupId || !phone) return { success: false, message: 'groupId and phone are required' };
            const saved = await this.saveContact(phone, name);
            const gid = this.formatJid(groupId, true);
            const jid = this.formatJid(phone, false);
            const result = await this.socket.groupParticipantsUpdate(gid, [jid], 'add');
            const entry = Array.isArray(result) ? result[0] : null;
            const code = entry && entry.status ? String(entry.status) : '200';
            const ok = code === '200';
            return {
                success: ok,
                message: ok ? 'Contact saved and added to group' : `Saved, but group add returned status ${code}`,
                data: {
                    groupId: gid,
                    phone: jid.split('@')[0],
                    jid,
                    contactSaved: saved.success,
                    contactSaveError: saved.success ? undefined : saved.message,
                    addStatus: code,
                    result
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== GROUPS ====================

    async getChats() {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const chats = await this.socket.groupFetchAllParticipating();
            const groups = Object.values(chats).map(group => ({
                id: group.id,
                name: group.subject,
                isGroup: true,
                owner: group.owner,
                creation: group.creation,
                participantsCount: group.participants?.length || 0,
                desc: group.desc || null
            }));

            return {
                success: true,
                data: {
                    groups: groups,
                    totalGroups: groups.length
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async getGroupMetadata(groupId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatJid(groupId, true);
            const metadata = await this.socket.groupMetadata(jid);

            return {
                success: true,
                data: {
                    id: metadata.id,
                    name: metadata.subject,
                    owner: metadata.owner,
                    creation: metadata.creation,
                    desc: metadata.desc || null,
                    descId: metadata.descId || null,
                    participants: metadata.participants.map(p => ({
                        id: p.id,
                        admin: p.admin || null,
                        phone: p.id.split('@')[0]
                    })),
                    participantsCount: metadata.participants.length
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== LABELS ====================

    /**
     * Get all labels
     */
    async getLabels() {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }
            if (!this.store) {
                return { success: false, message: 'Store not initialized' };
            }

            const labels = this.store.getLabels();
            return {
                success: true,
                data: { labels, total: labels.length }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get label by ID
     */
    async getLabelById(labelId) {
        try {
            if (!this.store) {
                return { success: false, message: 'Store not initialized' };
            }

            const label = this.store.getLabelById(labelId);
            if (!label) {
                return { success: false, message: 'Label not found' };
            }
            return { success: true, data: label };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Add label to chat
     */
    async addChatLabel(chatId, labelId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);
            await this.socket.addChatLabel(jid, labelId);

            // Update store immediately
            if (this.store) {
                this.store.addLabelAssociation(jid, labelId);
            }

            return { success: true, message: 'Label added to chat', data: { chatId: jid, labelId } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove label from chat
     */
    async removeChatLabel(chatId, labelId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);
            await this.socket.removeChatLabel(jid, labelId);

            // Update store immediately
            if (this.store) {
                this.store.removeLabelAssociation(jid, labelId);
            }

            return { success: true, message: 'Label removed from chat', data: { chatId: jid, labelId } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Add label to a specific message
     */
    async addMessageLabel(chatId, messageId, labelId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            if (typeof this.socket.addMessageLabel !== 'function') {
                return { success: false, message: 'Message labeling not supported in this Baileys version' };
            }

            await this.socket.addMessageLabel(jid, messageId, labelId);
            return { success: true, message: 'Label added to message', data: { chatId: jid, messageId, labelId } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove label from a specific message
     */
    async removeMessageLabel(chatId, messageId, labelId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            if (typeof this.socket.removeMessageLabel !== 'function') {
                return { success: false, message: 'Message labeling not supported in this Baileys version' };
            }

            await this.socket.removeMessageLabel(jid, messageId, labelId);
            return { success: true, message: 'Label removed from message', data: { chatId: jid, messageId, labelId } };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get all chats with a specific label
     */
    async getChatsByLabel(labelId) {
        try {
            if (!this.store) {
                return { success: false, message: 'Store not initialized' };
            }

            const label = this.store.getLabelById(labelId);
            if (!label) {
                return { success: false, message: 'Label not found' };
            }

            const chats = this.store.getChatsByLabel(labelId);
            return {
                success: true,
                data: { label, chats, total: chats.length }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get all labels for a specific chat
     */
    async getLabelsByChat(chatId) {
        try {
            if (!this.store) {
                return { success: false, message: 'Store not initialized' };
            }

            const jid = this.formatChatId(chatId);
            const labels = this.store.getLabelsByChat(jid);
            return {
                success: true,
                data: { chatId: jid, labels, total: labels.length }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== CHAT HISTORY ====================

    /**
     * Get chats overview - OPTIMIZED VERSION using pre-computed cache
     */
    async getChatsOverview(limit = 50, offset = 0, type = 'all') {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!this.store) {
                return { success: false, message: 'Store not initialized' };
            }

            // Get pre-sorted overview from cache (fast O(1) lookup + slice)
            const result = this.store.getChatsOverviewFast({ limit: 1000, offset: 0 });
            let chats = result.data;

            // Filter by type if needed
            if (type === 'group') {
                chats = chats.filter(c => c.isGroup);
            } else if (type === 'personal') {
                chats = chats.filter(c => !c.isGroup);
            }

            // Apply pagination
            const total = chats.length;
            const paginatedChats = chats.slice(offset, offset + limit);

            // Pre-resolve uncached LIDs with ONE batched USync query (plus cooldown
            // after failures). Local sources are checked first; only unmapped LIDs
            // go over the wire — this is what avoids `rate-overlimit`.
            const lids = [...new Set(
                paginatedChats
                    .filter((c) => !c.isGroup && c.id.endsWith('@lid'))
                    .map((c) => c.id)
            )];
            await this._resolveLidsBatch(lids);

            // Transform to expected format. LID-based chats are resolved via the
            // identity cache and, on cache miss, via the WhatsApp server so the
            // displayed phone number/name is always a real phone number.
            const formattedChats = await Promise.all(
                paginatedChats.map(async (chat) => {
                    const identity = await this._resolveChatIdentity(chat.id);
                    const resolvedId = identity.id;
                    const resolvedPhone = chat.isGroup ? null : identity.phone;

                    let resolvedName = chat.name;
                    if (chat.isGroup) {
                        resolvedName =
                            this.store?.groupMetadata.get(resolvedId)?.subject ||
                            chat.name ||
                            resolvedId.split('@')[0];
                    } else {
                        const contact = this.store?.getContact(resolvedId);
                        const rawLid = chat.id.endsWith('@lid') ? chat.id.split('@')[0] : null;
                        // Recompute the name if the cached overview still carries a raw LID
                        // or a stale numeric string that does not match the resolved phone.
                        const isNameJustDigits = resolvedName && /^\d+$/.test(resolvedName);
                        const nameDoesntMatchPhone = isNameJustDigits && resolvedPhone && resolvedName !== resolvedPhone;
                        if (!resolvedName || resolvedName === rawLid || resolvedName.endsWith('@lid') || nameDoesntMatchPhone) {
                            resolvedName =
                                contact?.name ||
                                contact?.notify ||
                                contact?.verifiedName ||
                                // Recover a display name from any incoming message's
                                // pushName (covers @lid chats whose last msg is outgoing).
                                this.store?._findPushName?.(resolvedId) ||
                                this.store?._findPushName?.(chat.id) ||
                                resolvedPhone ||
                                resolvedId.split('@')[0];
                        }
                    }

                    return {
                        id: resolvedId,
                        name: resolvedName,
                        phone: resolvedPhone,
                        isGroup: chat.isGroup,
                        profilePicture: chat.profilePicture,
                        participantsCount: chat.isGroup
                            ? this.store?.groupMetadata.get(resolvedId)?.participants?.length || null
                            : null,
                        lastMessage: chat.lastMessage?.preview || null,
                        lastMessageTimestamp: BaileysStore.toUnixSeconds(chat.lastMessage?.timestamp || chat.conversationTimestamp),
                        unreadCount: chat.unreadCount || 0
                    };
                })
            );

            // Fetch missing profile pictures in background (non-blocking)
            this._fetchMissingProfilePictures(formattedChats);

            return {
                success: true,
                data: {
                    total: total,
                    limit: limit,
                    offset: offset,
                    hasMore: offset + limit < total,
                    chats: formattedChats
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Fetch missing profile pictures in background (fire-and-forget, non-blocking)
     */
    _fetchMissingProfilePictures(items) {
        if (!this.socket || !this.store) return;
        const needPics = items.filter(c => !c.profilePicture).slice(0, 10);
        if (needPics.length === 0) return;

        // Fire and forget — don't await
        Promise.all(needPics.map(async (item) => {
            try {
                const url = await this.socket.profilePictureUrl(item.id, 'image');
                this.store.setProfilePicture(item.id, url);
            } catch (e) {
                // No profile picture available
            }
        })).catch(() => {});
    }

    /**
     * Get contacts list - OPTIMIZED VERSION using cache
     */
    async getContacts(limit = 50, offset = 0, search = '') {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!this.store) {
                return { success: false, message: 'Store not initialized' };
            }

            // Use fast method from BaileysStore
            const result = this.store.getContactsFast({ limit: 1000, offset: 0, search });
            let contacts = result.data;

            // Apply pagination
            const total = contacts.length;
            const paginatedContacts = contacts.slice(offset, offset + limit);

            // Transform to expected format
            const formattedContacts = paginatedContacts.map(c => ({
                id: c.id,
                phone: c.id.split('@')[0],
                name: c.name,
                shortName: c.notify || null,
                pushName: c.notify || null,
                profilePicture: c.profilePicture
            }));

            // Fetch missing profile pictures in background (non-blocking)
            this._fetchMissingProfilePictures(paginatedContacts);

            return {
                success: true,
                data: {
                    total: total,
                    limit: limit,
                    offset: offset,
                    hasMore: offset + limit < total,
                    contacts: formattedContacts
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async getChatMessages(chatId, limit = 50, cursor = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Resolve unmapped LID from server
            if (jid && jid.endsWith('@lid') && this.store && !this.store.resolveIdentity(jid)) {
                await this.resolveLidFromServer(jid);
            }

            const isGroup = this.isGroupId(jid);

            let messages = [];

            // Try to fetch from server first (if fetchMessageHistory is available)
            if (typeof this.socket.fetchMessageHistory === 'function') {
                try {
                    const cursorMsg = cursor ? {
                        before: {
                            id: cursor,
                            fromMe: false,
                            remoteJid: jid
                        }
                    } : undefined;

                    const result = await this.socket.fetchMessageHistory(limit, cursorMsg, jid);
                    if (Array.isArray(result)) {
                        messages = result;
                    }
                } catch (fetchError) {
                    // Silent fail, will use store as fallback
                }
            }

            // Fallback: Try to get messages from store
            if (messages.length === 0 && this.store) {
                try {
                    const storeMessages = this.store.getMessages(jid, { limit, before: cursor });
                    if (storeMessages && storeMessages.length > 0) {
                        messages = storeMessages;
                    }
                } catch (storeError) {
                    console.log(`[${this.sessionId}] Store messages error:`, storeError.message);
                }
            }

            const formattedMessages = messages
                .filter(msg => msg && msg.key) // Filter invalid messages
                .map(msg => MessageFormatter.formatMessage(msg, this.store))
                .filter(msg => msg !== null);

            return {
                success: true,
                data: {
                    chatId: jid,
                    isGroup: isGroup,
                    total: formattedMessages.length,
                    limit: limit,
                    cursor: formattedMessages.length > 0
                        ? formattedMessages[formattedMessages.length - 1].id
                        : null,
                    hasMore: formattedMessages.length === limit,
                    messages: formattedMessages
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async getChatInfo(chatId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);

            // Resolve unmapped LID from server
            if (jid && jid.endsWith('@lid') && this.store && !this.store.resolveIdentity(jid)) {
                await this.resolveLidFromServer(jid);
            }

            const isGroup = this.isGroupId(jid);

            let profilePicture = null;
            try {
                profilePicture = await this.socket.profilePictureUrl(jid, 'image');
            } catch (e) {}

            if (isGroup) {
                try {
                    const metadata = await this.socket.groupMetadata(jid);
                    return {
                        success: true,
                        data: {
                            id: jid,
                            name: metadata.subject,
                            isGroup: true,
                            profilePicture: profilePicture,
                            owner: metadata.owner,
                            ownerPhone: metadata.owner?.split('@')[0],
                            creation: metadata.creation,
                            description: metadata.desc || null,
                            participants: metadata.participants.map(p => {
                                let resolvedId = p.id;
                                let resolvedPhone = null;
                                // 1. Prefer the phone number WhatsApp ships inside the
                                //    group metadata (full PN JID for LID participants).
                                const metaDigits = this._extractPhoneDigits(p.phoneNumber);
                                if (metaDigits) {
                                    resolvedId = `${metaDigits}@c.us`;
                                    resolvedPhone = metaDigits;
                                    this.store?.registerIdentity(p.id, resolvedId);
                                } else if (this.store) {
                                    // 2. Fall back to our cached LID→PN mapping.
                                    const resolved = this.store.resolveIdentity(p.id);
                                    if (resolved) {
                                        resolvedId = resolved.jid || resolvedId;
                                        resolvedPhone = resolved.pn || null;
                                    }
                                }
                                // 3. Last resort: only expose bare digits when it is a
                                //    real phone JID — never surface a raw LID as a number.
                                if (!resolvedPhone) {
                                    resolvedPhone = this._extractPhoneDigits(resolvedId);
                                }
                                return {
                                    id: resolvedId,
                                    phone: resolvedPhone,
                                    isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                                    isSuperAdmin: p.admin === 'superadmin'
                                };
                            }),
                            participantsCount: metadata.participants.length
                        }
                    };
                } catch (e) {
                    return { success: false, message: 'Failed to get group info' };
                }
            } else {
                let resolvedJid = jid;
                let phone = jid.split('@')[0];
                if (this.store) {
                    const resolved = this.store.resolveIdentity(jid);
                    if (resolved) {
                        resolvedJid = resolved.jid || resolvedJid;
                        phone = resolved.pn || phone;
                    }
                }

                let status = null;
                try {
                    const statusResult = await this.socket.fetchStatus(jid);
                    status = statusResult?.status || null;
                } catch (e) {}

                let isRegistered = false;
                try {
                    const [result] = await this.socket.onWhatsApp(phone);
                    isRegistered = !!result?.exists;
                } catch (e) {}

                return {
                    success: true,
                    data: {
                        id: resolvedJid,
                        phone: phone,
                        isGroup: false,
                        profilePicture: profilePicture,
                        status: status,
                        isRegistered: isRegistered
                    }
                };
            }
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== CHAT READ STATUS ====================

    /**
     * Mark a chat as read
     * @param {string} chatId - Chat ID (phone number or group ID)
     * @param {string|null} messageId - Optional specific message ID to mark as read
     */
    async markChatRead(chatId, messageId = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const jid = this.formatChatId(chatId);
            const isGroup = this.isGroupId(jid);

            console.log(`[${this.sessionId}] markChatRead: jid=${jid}, isGroup=${isGroup}`);

            // Get messages from store
            const storeMessages = this.store?.getMessages(jid, { limit: 50 }) || [];
            console.log(`[${this.sessionId}] Found ${storeMessages.length} messages in store for ${jid}`);

            // Collect message keys to mark as read
            const keysToRead = [];
            for (const msg of storeMessages) {
                // Only mark incoming messages (not from me)
                if (msg?.key && !msg.key.fromMe && msg.key.id) {
                    const readKey = {
                        remoteJid: jid,
                        id: msg.key.id
                    };
                    // Add participant for group messages
                    if (isGroup && msg.key.participant) {
                        readKey.participant = msg.key.participant;
                    }
                    keysToRead.push(readKey);
                }
            }

            if (keysToRead.length > 0) {
                console.log(`[${this.sessionId}] Marking ${keysToRead.length} messages as read`);
                await this.socket.readMessages(keysToRead);
                console.log(`✅ [${this.sessionId}] Messages marked as read: ${jid}`);
            } else {
                console.log(`[${this.sessionId}] No unread messages found in store for ${jid}`);
            }

            return {
                success: true,
                message: 'Chat marked as read',
                data: {
                    chatId: jid,
                    isGroup: isGroup,
                    markedCount: keysToRead.length
                }
            };
        } catch (error) {
            console.error(`[${this.sessionId}] Mark read error:`, error);
            return { success: false, message: error.message || 'Failed to mark as read' };
        }
    }

    // ==================== MEDIA DOWNLOAD ====================

    /**
     * Auto-save media when message received
     */
    async _autoSaveMedia(message, { force = false } = {}) {
        try {
            if (!message.message) return null;

            const contentType = getContentType(message.message);
            const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

            if (!contentType || !mediaTypes.includes(contentType)) return null;

            const mediaContent = message.message[contentType];
            const _size = Number(mediaContent?.fileLength) || 0;
            if (!force && _size > MEDIA_AUTOSAVE_MAX_BYTES) {
                return null;
            }
            if (!mediaContent) return null;

            // Download media
            const buffer = await downloadMediaMessage(
                message,
                'buffer',
                {},
                { logger: console, reuploadRequest: this.socket?.updateMediaMessage }
            );

            // Create media folder structure: public/media/{sessionId}/{chatId}/
            const chatId = message.key.remoteJid.replace('@c.us', '').replace('@g.us', '');
            const mediaDir = path.join(this.mediaFolder, chatId);

            if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
            }

            // Generate filename
            const mimetype = mediaContent.mimetype || this._getMimetype(contentType);
            const ext = this._getExtFromMimetype(mimetype);
            const filename = `${message.key.id}.${ext}`;
            const filePath = path.join(mediaDir, filename);

            // Save file
            fs.writeFileSync(filePath, buffer);

            // Register media file in store for cleanup tracking
            if (this.store) {
                this.store.registerMediaFile(message.key.id, filePath);
            }

            // Store media path in message for later reference
            const relativePath = `/media/${this.sessionId}/${chatId}/${filename}`;

            console.log(`💾 [${this.sessionId}] Media saved: ${relativePath}`);

            // Update message in store with media path (and the object we were handed)
            message._mediaPath = relativePath;
            message._mediaLocalPath = filePath;
            if (this.store) {
                const chatMessages = this.store.messages.get(message.key.remoteJid);
                if (chatMessages && chatMessages.has(message.key.id)) {
                    const msg = chatMessages.get(message.key.id);
                    if (msg) {
                        msg._mediaPath = relativePath;
                        msg._mediaLocalPath = filePath;
                    }
                }
            }

            return relativePath;
        } catch (error) {
            console.error(`[${this.sessionId}] Auto-save media error:`, error.message);
            return null;
        }
    }

    _getMimetype(contentType) {
        const map = {
            'imageMessage': 'image/jpeg',
            'videoMessage': 'video/mp4',
            'audioMessage': 'audio/ogg; codecs=opus',
            'documentMessage': 'application/octet-stream',
            'stickerMessage': 'image/webp'
        };
        return map[contentType] || 'application/octet-stream';
    }

    _getExtFromMimetype(mimetype) {
        const map = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
            'video/mp4': 'mp4', 'video/3gpp': '3gp',
            'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
            'application/pdf': 'pdf'
        };
        return map[mimetype] || mimetype.split('/')[1]?.split(';')[0] || 'bin';
    }

    // Legacy methods for backward compatibility
    async getMessages(chatId, isGroup = false, limit = 50) {
        return this.getChatMessages(chatId, limit, null);
    }

    async fetchMessages(chatId, isGroup = false, limit = 50, cursor = null) {
        return this.getChatMessages(chatId, limit, cursor);
    }

    // ==================== GROUP MANAGEMENT ====================

    /**
     * Create a new group
     * @param {string} name - Group name/subject
     * @param {Array<string>} participants - Array of phone numbers to add
     * @returns {Object}
     */
    async createGroup(name, participants) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!name || !participants || !Array.isArray(participants) || participants.length === 0) {
                return { success: false, message: 'Group name and at least one participant are required' };
            }

            // Format participant JIDs
            const participantJids = participants.map(p => this.formatPhoneNumber(p));

            const group = await this.socket.groupCreate(name, participantJids);

            return {
                success: true,
                message: 'Group created successfully',
                data: {
                    groupId: group.id,
                    groupJid: group.id,
                    subject: name,
                    participants: participantJids,
                    createdAt: new Date().toISOString()
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Add participants to a group
     * @param {string} groupId - Group JID
     * @param {Array<string>} participants - Array of phone numbers to add
     * @returns {Object}
     */
    async groupAddParticipants(groupId, participants) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId || !participants || !Array.isArray(participants) || participants.length === 0) {
                return { success: false, message: 'Group ID and participants are required' };
            }

            const gid = this.formatJid(groupId, true);
            const participantJids = participants.map(p => this.formatPhoneNumber(p));

            const result = await this.socket.groupParticipantsUpdate(gid, participantJids, 'add');

            return {
                success: true,
                message: 'Participants added successfully',
                data: {
                    groupId: gid,
                    participants: result
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove participants from a group
     * @param {string} groupId - Group JID
     * @param {Array<string>} participants - Array of phone numbers to remove
     * @returns {Object}
     */
    async groupRemoveParticipants(groupId, participants) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId || !participants || !Array.isArray(participants) || participants.length === 0) {
                return { success: false, message: 'Group ID and participants are required' };
            }

            const gid = this.formatJid(groupId, true);
            const participantJids = participants.map(p => this.formatPhoneNumber(p));

            const result = await this.socket.groupParticipantsUpdate(gid, participantJids, 'remove');

            return {
                success: true,
                message: 'Participants removed successfully',
                data: {
                    groupId: gid,
                    participants: result
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Promote participants to admin
     * @param {string} groupId - Group JID
     * @param {Array<string>} participants - Array of phone numbers to promote
     * @returns {Object}
     */
    async groupPromoteParticipants(groupId, participants) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId || !participants || !Array.isArray(participants) || participants.length === 0) {
                return { success: false, message: 'Group ID and participants are required' };
            }

            const gid = this.formatJid(groupId, true);
            const participantJids = participants.map(p => this.formatPhoneNumber(p));

            const result = await this.socket.groupParticipantsUpdate(gid, participantJids, 'promote');

            return {
                success: true,
                message: 'Participants promoted to admin successfully',
                data: {
                    groupId: gid,
                    participants: result
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Demote participants from admin
     * @param {string} groupId - Group JID
     * @param {Array<string>} participants - Array of phone numbers to demote
     * @returns {Object}
     */
    async groupDemoteParticipants(groupId, participants) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId || !participants || !Array.isArray(participants) || participants.length === 0) {
                return { success: false, message: 'Group ID and participants are required' };
            }

            const gid = this.formatJid(groupId, true);
            const participantJids = participants.map(p => this.formatPhoneNumber(p));

            const result = await this.socket.groupParticipantsUpdate(gid, participantJids, 'demote');

            return {
                success: true,
                message: 'Participants demoted from admin successfully',
                data: {
                    groupId: gid,
                    participants: result
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Update group subject (name)
     * @param {string} groupId - Group JID
     * @param {string} subject - New group name
     * @returns {Object}
     */
    async groupUpdateSubject(groupId, subject) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId || !subject) {
                return { success: false, message: 'Group ID and subject are required' };
            }

            const gid = this.formatJid(groupId, true);
            await this.socket.groupUpdateSubject(gid, subject);

            return {
                success: true,
                message: 'Group subject updated successfully',
                data: {
                    groupId: gid,
                    subject: subject
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Update group description
     * @param {string} groupId - Group JID
     * @param {string} description - New group description
     * @returns {Object}
     */
    async groupUpdateDescription(groupId, description) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId) {
                return { success: false, message: 'Group ID is required' };
            }

            const gid = this.formatJid(groupId, true);
            await this.socket.groupUpdateDescription(gid, description || '');

            return {
                success: true,
                message: 'Group description updated successfully',
                data: {
                    groupId: gid,
                    description: description || ''
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Leave a group
     * @param {string} groupId - Group JID
     * @returns {Object}
     */
    async groupLeave(groupId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId) {
                return { success: false, message: 'Group ID is required' };
            }

            const gid = this.formatJid(groupId, true);
            await this.socket.groupLeave(gid);

            return {
                success: true,
                message: 'Left group successfully',
                data: {
                    groupId: gid
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Join a group using invitation code
     * @param {string} inviteCode - Group invitation code (from invite link)
     * @returns {Object}
     */
    async groupJoinByInvite(inviteCode) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!inviteCode) {
                return { success: false, message: 'Invitation code is required' };
            }

            // Remove URL prefix if present (https://chat.whatsapp.com/...)
            const code = inviteCode.replace(/^https?:\/\/chat\.whatsapp\.com\//, '');

            const groupId = await this.socket.groupAcceptInvite(code);

            return {
                success: true,
                message: 'Joined group successfully',
                data: {
                    groupId: groupId,
                    inviteCode: code
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get group invitation code
     * @param {string} groupId - Group JID
     * @returns {Object}
     */
    async groupGetInviteCode(groupId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId) {
                return { success: false, message: 'Group ID is required' };
            }

            const gid = this.formatJid(groupId, true);
            const code = await this.socket.groupInviteCode(gid);

            return {
                success: true,
                message: 'Invite code retrieved successfully',
                data: {
                    groupId: gid,
                    inviteCode: code,
                    inviteLink: `https://chat.whatsapp.com/${code}`
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Revoke group invitation code
     * @param {string} groupId - Group JID
     * @returns {Object}
     */
    async groupRevokeInvite(groupId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId) {
                return { success: false, message: 'Group ID is required' };
            }

            const gid = this.formatJid(groupId, true);
            const newCode = await this.socket.groupRevokeInvite(gid);

            return {
                success: true,
                message: 'Invite code revoked successfully',
                data: {
                    groupId: gid,
                    newInviteCode: newCode,
                    newInviteLink: `https://chat.whatsapp.com/${newCode}`
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get group metadata
     * @param {string} groupId - Group JID
     * @returns {Object}
     */
    async groupGetMetadata(groupId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId) {
                return { success: false, message: 'Group ID is required' };
            }

            const gid = this.formatJid(groupId, true);
            const metadata = await this.socket.groupMetadata(gid);

            return {
                success: true,
                message: 'Group metadata retrieved successfully',
                data: {
                    id: metadata.id,
                    subject: metadata.subject,
                    subjectOwner: metadata.subjectOwner,
                    subjectTime: metadata.subjectTime,
                    description: metadata.desc,
                    descriptionId: metadata.descId,
                    restrict: metadata.restrict,
                    announce: metadata.announce,
                    size: metadata.size,
                    participants: metadata.participants?.map(p => {
                        // Resolve a real phone number: metadata phone_number first,
                        // then cached LID→PN mapping, then bare digits if it is a PN JID.
                        let phone = this._extractPhoneDigits(p.phoneNumber);
                        let id = p.id;
                        if (phone) {
                            id = `${phone}@c.us`;
                            this.store?.registerIdentity(p.id, id);
                        } else if (this.store) {
                            const resolved = this.store.resolveIdentity(p.id);
                            if (resolved?.jid) {
                                id = resolved.jid;
                                phone = resolved.pn || this._extractPhoneDigits(resolved.jid);
                            }
                        }
                        if (!phone) phone = this._extractPhoneDigits(id);
                        return {
                            id,
                            phone,
                            admin: p.admin || null,
                            isSuperAdmin: p.admin === 'superadmin'
                        };
                    }),
                    creation: metadata.creation,
                    owner: metadata.owner
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get all participating groups metadata
     * @returns {Object}
     */
    async getAllGroups() {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const groups = await this.socket.groupFetchAllParticipating();

            const groupList = Object.values(groups).map(g => ({
                id: g.id,
                subject: g.subject,
                subjectOwner: g.subjectOwner,
                subjectTime: g.subjectTime,
                description: g.desc,
                restrict: g.restrict,
                announce: g.announce,
                size: g.size,
                participantsCount: g.participants?.length || 0,
                creation: g.creation,
                owner: g.owner
            }));

            return {
                success: true,
                message: 'Groups retrieved successfully',
                data: {
                    count: groupList.length,
                    groups: groupList
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Update group settings (who can send messages, who can edit group info)
     * @param {string} groupId - Group JID
     * @param {string} setting - 'announcement' (only admins send) or 'not_announcement' (all can send)
     *                          or 'locked' (only admins edit) or 'unlocked' (all can edit)
     * @returns {Object}
     */
    async groupUpdateSettings(groupId, setting) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId || !setting) {
                return { success: false, message: 'Group ID and setting are required' };
            }

            const validSettings = ['announcement', 'not_announcement', 'locked', 'unlocked'];
            if (!validSettings.includes(setting)) {
                return {
                    success: false,
                    message: `Invalid setting. Use: ${validSettings.join(', ')}`
                };
            }

            const gid = this.formatJid(groupId, true);
            await this.socket.groupSettingUpdate(gid, setting);

            return {
                success: true,
                message: 'Group settings updated successfully',
                data: {
                    groupId: gid,
                    setting: setting
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Update group profile picture
     * @param {string} groupId - Group JID
     * @param {string} imageUrl - Image URL
     * @returns {Object}
     */
    async groupUpdateProfilePicture(groupId, imageUrl) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!groupId || !imageUrl) {
                return { success: false, message: 'Group ID and image URL are required' };
            }

            const gid = this.formatJid(groupId, true);
            await this.socket.updateProfilePicture(gid, { url: imageUrl });

            return {
                success: true,
                message: 'Group profile picture updated successfully',
                data: {
                    groupId: gid
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== LABELS ====================

    /**
     * Get all labels
     * @returns {Object}
     */
    async getLabels() {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            const labels = this.socket.store?.labels;
            if (!labels) {
                return { success: false, message: 'Label store not available' };
            }

            const allLabels = labels.get()?.map?.(label => ({
                id: label.id,
                name: label.name,
                color: label.color,
                predefinedId: label.predefinedId || null
            })) || [];

            return {
                success: true,
                data: {
                    labels: allLabels,
                    count: allLabels.length
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Create or update a label
     * @param {string} name - Label name
     * @param {number} colorId - Color ID (0-19)
     * @param {string|null} labelId - Existing label ID to update (optional)
     * @returns {Object}
     */
    async createLabel(name, colorId = 0, labelId = null) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!name) {
                return { success: false, message: 'Label name is required' };
            }

            if (colorId < 0 || colorId > 19) {
                return { success: false, message: 'Color ID must be between 0 and 19' };
            }

            const result = await this.socket.addLabel({
                name,
                color: colorId,
                id: labelId || undefined
            });

            return {
                success: true,
                message: labelId ? 'Label updated successfully' : 'Label created successfully',
                data: {
                    labelId: result.id || labelId,
                    name: name,
                    color: colorId
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Delete a label
     * @param {string} labelId - Label ID to delete
     * @returns {Object}
     */
    async deleteLabel(labelId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!labelId) {
                return { success: false, message: 'Label ID is required' };
            }

            const result = await this.socket.addLabel({
                name: '',
                color: 0,
                id: labelId,
                deleted: true
            });

            return {
                success: true,
                message: 'Label deleted successfully',
                data: {
                    labelId: labelId
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Add label to a chat
     * @param {string} chatId - Chat JID
     * @param {string} labelId - Label ID
     * @returns {Object}
     */
    async addChatLabel(chatId, labelId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!chatId || !labelId) {
                return { success: false, message: 'Chat ID and label ID are required' };
            }

            const isGroup = this.isGroupId(chatId);
            const jid = this.formatChatId(chatId, isGroup);
            await this.socket.chatModify({ addChatLabel: { type: 'label_jid', chatId: jid, labelId } }, jid);

            return {
                success: true,
                message: 'Label added to chat',
                data: {
                    chatId: jid,
                    labelId: labelId
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Remove label from a chat
     * @param {string} chatId - Chat JID
     * @param {string} labelId - Label ID
     * @returns {Object}
     */
    async removeChatLabel(chatId, labelId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!chatId || !labelId) {
                return { success: false, message: 'Chat ID and label ID are required' };
            }

            const isGroup = this.isGroupId(chatId);
            const jid = this.formatChatId(chatId, isGroup);
            await this.socket.chatModify({ removeChatLabel: { type: 'label_jid', chatId: jid, labelId } }, jid);

            return {
                success: true,
                message: 'Label removed from chat',
                data: {
                    chatId: jid,
                    labelId: labelId
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get labels for a specific chat
     * @param {string} chatId - Chat JID
     * @returns {Object}
     */
    async getChatLabels(chatId) {
        try {
            if (!this.socket || this.connectionStatus !== 'connected') {
                return { success: false, message: 'Session not connected' };
            }

            if (!chatId) {
                return { success: false, message: 'Chat ID is required' };
            }

            const isGroup = this.isGroupId(chatId);
            const jid = this.formatChatId(chatId, isGroup);
            const chatLabelsRaw = this.socket.store?.getChatLabels?.(jid);
            const chatLabels = Array.isArray(chatLabelsRaw) ? chatLabelsRaw : [];

            const labels = this.socket.store?.labels;
            const allLabels = Array.isArray(labels?.get?.()) ? labels.get() : [];

            const chatLabelIds = chatLabels.map(cl => cl.labelId);
            const detailedLabels = allLabels.filter(l => chatLabelIds.includes(l.id)).map(l => ({
                id: l.id,
                name: l.name,
                color: l.color
            }));

            return {
                success: true,
                data: {
                    chatId: jid,
                    labels: detailedLabels
                }
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
}

module.exports = WhatsAppSession;
