const { Server } = require('socket.io');

/**
 * WebSocket Manager (Singleton)
 * Mengelola koneksi WebSocket dan event broadcasting
 */
class WebSocketManager {
    constructor() {
        this.io = null;
        this.sessionRooms = new Map(); // sessionId -> Set of socket IDs
    }

    /**
     * Initialize Socket.IO server
     * @param {http.Server} httpServer - HTTP server instance
     * @param {Object} options - Socket.IO options
     */
    initialize(httpServer, options = {}) {
        this.io = new Server(httpServer, {
            cors: {
                origin: options.cors?.origin || '*',
                methods: ['GET', 'POST'],
                credentials: true
            },
            pingTimeout: 60000,
            pingInterval: 25000,
            ...options
        });

        this._setupConnectionHandlers();
        console.log('🔌 WebSocket server initialized');
        return this.io;
    }

    /**
     * Setup connection event handlers
     */
    _setupConnectionHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`🔗 Client connected: ${socket.id}`);

            // Client subscribes to a session
            socket.on('subscribe', (sessionId) => {
                if (!sessionId) {
                    socket.emit('error', { message: 'Session ID is required' });
                    return;
                }

                // Join the session room
                socket.join(`session:${sessionId}`);
                
                // Track socket in session room
                if (!this.sessionRooms.has(sessionId)) {
                    this.sessionRooms.set(sessionId, new Set());
                }
                this.sessionRooms.get(sessionId).add(socket.id);

                console.log(`📡 Client ${socket.id} subscribed to session: ${sessionId}`);
                socket.emit('subscribed', { 
                    sessionId, 
                    message: `Subscribed to session ${sessionId}` 
                });
            });

            // Client unsubscribes from a session
            socket.on('unsubscribe', (sessionId) => {
                if (!sessionId) return;

                socket.leave(`session:${sessionId}`);
                
                if (this.sessionRooms.has(sessionId)) {
                    this.sessionRooms.get(sessionId).delete(socket.id);
                    if (this.sessionRooms.get(sessionId).size === 0) {
                        this.sessionRooms.delete(sessionId);
                    }
                }

                console.log(`📴 Client ${socket.id} unsubscribed from session: ${sessionId}`);
                socket.emit('unsubscribed', { sessionId });
            });

            // Handle disconnect
            socket.on('disconnect', (reason) => {
                console.log(`🔌 Client disconnected: ${socket.id} - Reason: ${reason}`);
                
                // Remove socket from all session rooms
                for (const [sessionId, sockets] of this.sessionRooms.entries()) {
                    if (sockets.has(socket.id)) {
                        sockets.delete(socket.id);
                        if (sockets.size === 0) {
                            this.sessionRooms.delete(sessionId);
                        }
                    }
                }
            });

            // Ping-pong for connection health check
            socket.on('ping', () => {
                socket.emit('pong', { timestamp: Date.now() });
            });
        });
    }

    /**
     * Emit event to specific session subscribers
     * @param {string} sessionId - Session ID
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    emitToSession(sessionId, event, data) {
        if (!this.io) {
            console.warn('WebSocket server not initialized');
            return;
        }

        this.io.to(`session:${sessionId}`).emit(event, {
            sessionId,
            timestamp: new Date().toISOString(),
            ...data
        });
    }

    /**
     * Emit event to all connected clients
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    broadcast(event, data) {
        if (!this.io) {
            console.warn('WebSocket server not initialized');
            return;
        }

        this.io.emit(event, {
            timestamp: new Date().toISOString(),
            ...data
        });
    }

    // ==================== WhatsApp Event Emitters ====================

    /**
     * Emit QR code event
     */
    emitQRCode(sessionId, qrCode) {
        this.emitToSession(sessionId, 'qr', { qrCode });
    }

    /**
     * Emit connection status change
     */
    emitConnectionStatus(sessionId, status, details = {}) {
        this.emitToSession(sessionId, 'connection.update', { 
            status,
            ...details
        });
    }

    /**
     * Emit new message received
     */
    emitMessage(sessionId, message) {
        this.emitToSession(sessionId, 'message', { message });
    }

    /**
     * Emit message sent confirmation
     */
    emitMessageSent(sessionId, message) {
        this.emitToSession(sessionId, 'message.sent', { message });
    }

    /**
     * Emit message status update (read, delivered, etc)
     */
    emitMessageStatus(sessionId, update) {
        this.emitToSession(sessionId, 'message.update', { update });
    }

    /**
     * Emit message deleted/revoked
     */
    emitMessageRevoke(sessionId, key, participant) {
        this.emitToSession(sessionId, 'message.revoke', { key, participant });
    }

    /**
     * Emit chat update (archive, mute, pin, etc)
     */
    emitChatUpdate(sessionId, chats) {
        this.emitToSession(sessionId, 'chat.update', { chats });
    }

    /**
     * Emit new chat created
     */
    emitChatsUpsert(sessionId, chats) {
        this.emitToSession(sessionId, 'chat.upsert', { chats });
    }

    /**
     * Emit chat deleted
     */
    emitChatDelete(sessionId, chatIds) {
        this.emitToSession(sessionId, 'chat.delete', { chatIds });
    }

    /**
     * Emit contact update
     */
    emitContactUpdate(sessionId, contacts) {
        this.emitToSession(sessionId, 'contact.update', { contacts });
    }

    /**
     * Emit presence update (typing, online, etc)
     */
    emitPresence(sessionId, presence) {
        this.emitToSession(sessionId, 'presence.update', { presence });
    }

    /**
     * Emit group participants update
     */
    emitGroupParticipants(sessionId, update) {
        this.emitToSession(sessionId, 'group.participants', { update });
    }

    /**
     * Emit group update (name, description, etc)
     */
    emitGroupUpdate(sessionId, update) {
        this.emitToSession(sessionId, 'group.update', { update });
    }

    /**
     * Emit call event
     */
    emitCall(sessionId, call) {
        this.emitToSession(sessionId, 'call', { call });
    }

    /**
     * Emit labels update
     */
    emitLabels(sessionId, labels) {
        this.emitToSession(sessionId, 'labels', { labels });
    }

    /**
     * Emit session logged out
     */
    emitLoggedOut(sessionId) {
        this.emitToSession(sessionId, 'logged.out', { 
            message: 'Session has been logged out' 
        });
    }

    /**
     * Get connection stats
     */
    getStats() {
        if (!this.io) return null;

        const rooms = {};
        for (const [sessionId, sockets] of this.sessionRooms.entries()) {
            rooms[sessionId] = sockets.size;
        }

        return {
            totalConnections: this.io.engine?.clientsCount || 0,
            sessionRooms: rooms
        };
    }
}

// Singleton instance
const wsManager = new WebSocketManager();

module.exports = wsManager;
