const express = require('express');
const router = express.Router();
const whatsappManager = require('../services/whatsapp');
const bulkJobManager = require('../services/whatsapp/BulkJobManager');
const { parseProxyUrl, checkProxy } = require('../services/whatsapp/proxy');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ==================== FILE UPLOADS ====================
//
// Files land in public/media/<sessionId>/uploads/ and are served by the
// existing /media static mount, so the returned URL works for the dashboard
// and can be passed straight back into any send-* endpoint.

const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 64 * 1024 * 1024;

const safeFilename = (name) => {
    const base = path.basename(name || 'file').replace(/[^\w.\-() ]+/g, '_').slice(-120);
    return base || 'file';
};

const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionId = req.body?.sessionId;
        if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
            return cb(new Error('Missing or invalid sessionId (send it before the file in the form)'));
        }
        const dir = path.join(process.cwd(), 'public', 'media', sessionId, 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeFilename(file.originalname)}`);
    }
});

const upload = multer({ storage: uploadStorage, limits: { fileSize: UPLOAD_MAX_BYTES } });

/** Run a multer middleware and turn its errors into JSON 400s instead of a stack trace. */
const uploadSingle = (field) => (req, res, next) => {
    upload.single(field)(req, res, (error) => {
        if (!error) return next();
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? `File too large (max ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB)`
            : error.message;
        res.status(400).json({ success: false, message });
    });
};

/** Describe an uploaded file for API responses (never the disk path). */
const describeUpload = (req) => ({
    url: `/media/${req.body.sessionId}/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
});

/**
 * Normalise a `proxy` field from a request body: undefined = untouched,
 * null/"" = clear, otherwise a validated URL. Throws with a user-facing
 * message on a bad URL.
 */
const normaliseProxyInput = (value) => {
    if (value === undefined) return undefined;
    if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
    if (typeof value !== 'string') throw new Error('proxy must be a URL string or null');
    return parseProxyUrl(value).url;
};

/** Connection states in which a proxy change needs a socket restart to take effect. */
const LIVE_STATES = new Set(['connecting', 'qr_ready', 'connected']);

// Get all sessions
router.get('/sessions', (req, res) => {
    try {
        const sessions = whatsappManager.getAllSessions();
        res.json({
            success: true,
            message: 'Sessions retrieved',
            data: sessions.map(s => ({
                sessionId: s.sessionId,
                status: s.status,
                isConnected: s.isConnected,
                phoneNumber: s.phoneNumber,
                name: s.name,
                webhooks: s.webhooks || [],
                metadata: s.metadata || {},
                proxy: s.proxy || null
            }))
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Create/Connect a session
router.post('/sessions/:sessionId/connect', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { metadata, webhooks, proxy } = req.body || {};

        const options = {};
        if (metadata) options.metadata = metadata;
        if (webhooks) options.webhooks = webhooks;
        try {
            const proxyUrl = normaliseProxyInput(proxy);
            if (proxyUrl !== undefined) options.proxy = proxyUrl;
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }

        const result = await whatsappManager.createSession(sessionId, options);
        
        res.json({
            success: result.success,
            message: result.message,
            data: result.data
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Get session status
router.get('/sessions/:sessionId/status', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = whatsappManager.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        const info = session.getInfo();
        res.json({
            success: true,
            message: 'Status retrieved',
            data: {
                sessionId: info.sessionId,
                status: info.status,
                isConnected: info.isConnected,
                phoneNumber: info.phoneNumber,
                name: info.name,
                metadata: info.metadata,
                webhooks: info.webhooks,
                proxy: info.proxy
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Update session config (metadata, webhooks, proxy)
router.patch('/sessions/:sessionId/config', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { metadata, webhooks, proxy, reconnect = true } = req.body || {};

        const session = whatsappManager.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }

        const options = {};
        if (metadata !== undefined) options.metadata = metadata;
        if (webhooks !== undefined) options.webhooks = webhooks;
        let proxyUrl;
        try {
            proxyUrl = normaliseProxyInput(proxy);
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
        const proxyChanged = proxyUrl !== undefined && proxyUrl !== (session.proxy || null);
        if (proxyUrl !== undefined) options.proxy = proxyUrl;

        const updatedInfo = session.updateConfig(options);

        // A proxy only takes effect on the next socket; restart a live one now
        // unless the caller asked to defer.
        let message = 'Session config updated';
        let proxyApplied = !proxyChanged;
        if (proxyChanged) {
            if (LIVE_STATES.has(session.connectionStatus) && reconnect !== false) {
                const restart = await session.restart('Proxy changed');
                proxyApplied = restart.success;
                message = restart.success
                    ? 'Proxy saved — reconnecting the session through it'
                    : `Proxy saved, but restart failed: ${restart.message}`;
            } else {
                message = 'Proxy saved — it applies when the session next connects';
            }
        }

        res.json({
            success: true,
            message,
            data: {
                sessionId: updatedInfo.sessionId,
                metadata: updatedInfo.metadata,
                webhooks: updatedInfo.webhooks,
                proxy: updatedInfo.proxy,
                proxyApplied
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Test a proxy: fetch the egress IP through it. Pass `proxy` directly, or
// `sessionId` to test the proxy that session has configured.
router.post('/proxy/test', async (req, res) => {
    try {
        const { proxy, sessionId } = req.body || {};
        let target = proxy;

        if (target === undefined || target === null || target === '') {
            if (!sessionId) {
                return res.status(400).json({
                    success: false,
                    message: 'Provide proxy (URL) or sessionId'
                });
            }
            const session = whatsappManager.getSession(sessionId);
            if (!session) {
                return res.status(404).json({
                    success: false,
                    message: 'Session not found'
                });
            }
            if (!session.proxy) {
                return res.status(400).json({
                    success: false,
                    message: 'Session has no proxy configured'
                });
            }
            target = session.proxy;
        }

        try {
            target = parseProxyUrl(target).url;
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }

        const result = await checkProxy(target);
        res.json({
            success: result.ok,
            message: result.ok ? `Proxy reachable — egress IP ${result.ip}` : `Proxy check failed: ${result.error}`,
            data: result
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Upload a file for a session (multipart/form-data: sessionId, file).
// Returns a /media/... URL usable in send-image / send-document / bulk sends.
router.post('/media/upload', uploadSingle('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Missing file (multipart field "file")'
            });
        }
        if (!whatsappManager.getSession(req.body.sessionId)) {
            fs.rm(req.file.path, { force: true }, () => {});
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        res.json({
            success: true,
            message: 'File uploaded',
            data: describeUpload(req)
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Add a webhook to session
router.post('/sessions/:sessionId/webhooks', (req, res) => {
    try {
        const { sessionId } = req.params;
        const { url, events } = req.body || {};
        
        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: url'
            });
        }
        
        const session = whatsappManager.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        const updatedInfo = session.addWebhook(url, events || ['all']);
        
        res.json({
            success: true,
            message: 'Webhook added',
            data: {
                sessionId: updatedInfo.sessionId,
                webhooks: updatedInfo.webhooks
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Remove a webhook from session
router.delete('/sessions/:sessionId/webhooks', (req, res) => {
    try {
        const { sessionId } = req.params;
        const url = req.body?.url || req.query?.url;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: url (provide in body or query parameter)'
            });
        }
        
        const session = whatsappManager.getSession(sessionId);
        
        if (!session) {
            return res.status(404).json({
                success: false,
                message: 'Session not found'
            });
        }
        
        const updatedInfo = session.removeWebhook(url);
        
        res.json({
            success: true,
            message: 'Webhook removed',
            data: {
                sessionId: updatedInfo.sessionId,
                webhooks: updatedInfo.webhooks
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Get QR Code for session
router.get('/sessions/:sessionId/qr', (req, res) => {
    try {
        const { sessionId } = req.params;
        const sessionInfo = whatsappManager.getSessionQR(sessionId);
        
        if (!sessionInfo) {
            return res.status(404).json({
                success: false,
                message: 'Session not found. Please create session first.'
            });
        }

        if (sessionInfo.isConnected) {
            return res.json({
                success: true,
                message: 'Already connected to WhatsApp',
                data: { 
                    sessionId: sessionInfo.sessionId,
                    status: 'connected', 
                    qrCode: null 
                }
            });
        }

        if (!sessionInfo.qrCode) {
            return res.status(404).json({
                success: false,
                message: 'QR Code not available yet. Please wait...',
                data: { status: sessionInfo.status }
            });
        }

        res.json({
            success: true,
            message: 'QR Code ready',
            data: {
                sessionId: sessionInfo.sessionId,
                qrCode: sessionInfo.qrCode,
                qrExpiresAt: sessionInfo.qrExpiresAt,
                status: sessionInfo.status
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Get QR Code as Image for session
router.get('/sessions/:sessionId/qr/image', (req, res) => {
    try {
        const { sessionId } = req.params;
        const sessionInfo = whatsappManager.getSessionQR(sessionId);
        
        if (!sessionInfo || !sessionInfo.qrCode) {
            return res.status(404).send('QR Code not available');
        }

        // Konversi base64 ke buffer dan kirim sebagai image
        const base64Data = sessionInfo.qrCode.replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');
        
        res.set('Content-Type', 'image/png');
        res.send(imgBuffer);
    } catch (error) {
        res.status(500).send('Error generating QR image');
    }
});

// Delete/Logout a session
router.delete('/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await whatsappManager.deleteSession(sessionId);
        
        res.json({
            success: result.success,
            message: result.message
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ==================== CHAT API ====================

// Middleware untuk check session dari body
const checkSession = (req, res, next) => {
    if (!req.body) {
        return res.status(400).json({
            success: false,
            message: 'Request body is required'
        });
    }
    
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required field: sessionId'
        });
    }
    
    const session = whatsappManager.getSession(sessionId);
    
    if (!session) {
        return res.status(404).json({
            success: false,
            message: 'Session not found'
        });
    }
    
    if (session.connectionStatus !== 'connected') {
        return res.status(400).json({
            success: false,
            message: 'Session not connected. Please scan QR code first.'
        });
    }
    
    req.session = session;
    next();
};

// Send text message
router.post('/chats/send-text', checkSession, async (req, res) => {
    try {
        const { chatId, message, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !message) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, message'
            });
        }

        const result = await req.session.sendTextMessage(chatId, message, typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send image
router.post('/chats/send-image', checkSession, async (req, res) => {
    try {
        const { chatId, imageUrl, caption, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !imageUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, imageUrl'
            });
        }

        const result = await req.session.sendImage(chatId, imageUrl, caption || '', typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send document
router.post('/chats/send-document', checkSession, async (req, res) => {
    try {
        const { chatId, documentUrl, filename, mimetype, caption = '', typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !documentUrl || !filename) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, documentUrl, filename'
            });
        }

        const result = await req.session.sendDocument(chatId, documentUrl, filename, mimetype, caption, typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send video
router.post('/chats/send-video', checkSession, async (req, res) => {
    try {
        const { chatId, videoUrl, caption = '', typingTime = 0, replyTo = null, gifPlayback = false } = req.body;

        if (!chatId || !videoUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, videoUrl'
            });
        }

        const result = await req.session.sendVideo(chatId, videoUrl, caption, typingTime, replyTo, gifPlayback);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send an uploaded file in one request (multipart/form-data: sessionId, chatId,
// file, caption?, typingTime?, replyTo?, ptt?, asDocument?). The message kind
// follows the file's mimetype: image / video / audio / document.
router.post('/chats/send-media', uploadSingle('file'), checkSession, async (req, res) => {
    try {
        const { chatId, caption = '', typingTime = 0, replyTo = null, ptt, asDocument } = req.body;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Missing file (multipart field "file")'
            });
        }
        if (!chatId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: chatId'
            });
        }

        const result = await req.session.sendMedia(chatId, describeUpload(req), {
            caption,
            typingTime: Number(typingTime) || 0,
            replyTo: replyTo || null,
            ptt: ptt === true || ptt === 'true',
            asDocument: asDocument === true || asDocument === 'true'
        });
        res.status(result.success ? 200 : 400).json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send audio message (OGG format required)
router.post('/chats/send-audio', checkSession, async (req, res) => {
    try {
        const { chatId, audioUrl, ptt = false, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !audioUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, audioUrl'
            });
        }

        // Validate OGG format
        const urlLower = audioUrl.toLowerCase();
        if (!urlLower.endsWith('.ogg') && !urlLower.includes('.ogg?')) {
            return res.status(400).json({
                success: false,
                message: 'Audio must be in OGG format (.ogg). WhatsApp only supports OGG audio files.'
            });
        }

        const result = await req.session.sendAudio(chatId, audioUrl, ptt, typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send location
router.post('/chats/send-location', checkSession, async (req, res) => {
    try {
        const { chatId, latitude, longitude, name, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || latitude === undefined || longitude === undefined) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, latitude, longitude'
            });
        }

        const result = await req.session.sendLocation(chatId, latitude, longitude, name || '', typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send contact
router.post('/chats/send-contact', checkSession, async (req, res) => {
    try {
        const { chatId, contactName, contactPhone, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !contactName || !contactPhone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, contactName, contactPhone'
            });
        }

        const result = await req.session.sendContact(chatId, contactName, contactPhone, typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send button message (uses Poll as buttons are deprecated by WhatsApp)
router.post('/chats/send-button', checkSession, async (req, res) => {
    try {
        const { chatId, text, footer, buttons, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !text || !buttons || !Array.isArray(buttons)) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, text, buttons (array)'
            });
        }

        const result = await req.session.sendButton(chatId, text, footer || '', buttons, typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send poll message (alternative to buttons)
router.post('/chats/send-poll', checkSession, async (req, res) => {
    try {
        const { chatId, question, options, selectableCount = 1, typingTime = 0, replyTo = null } = req.body;
        
        if (!chatId || !question || !options || !Array.isArray(options)) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, question, options (array)'
            });
        }

        if (options.length < 2 || options.length > 12) {
            return res.status(400).json({
                success: false,
                message: 'Poll must have between 2 and 12 options'
            });
        }

        const result = await req.session.sendPoll(chatId, question, options, selectableCount, typingTime, replyTo);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ==================== BULK MESSAGING (Background Jobs) ====================
//
// All bulk sends run through BulkJobManager: it validates, runs the send loop
// in the background, emits `bulk.progress` / `bulk.completed` over WebSocket
// and webhooks, and keeps history in sessions/<id>/bulk-jobs.json.

// Like checkSession, but only requires the session to exist — job history and
// cancellation must work while the phone is offline.
const checkSessionExists = (req, res, next) => {
    const sessionId = req.body?.sessionId || req.query?.sessionId;

    if (!sessionId) {
        return res.status(400).json({
            success: false,
            message: 'Missing required field: sessionId'
        });
    }

    const session = whatsappManager.getSession(sessionId);

    if (!session) {
        return res.status(404).json({
            success: false,
            message: 'Session not found'
        });
    }

    req.session = session;
    next();
};

// Resolve the sending accounts for a bulk send. Accepts `sessionIds` (array,
// for multi-account rotation) or a single `sessionId`; only connected accounts
// become lanes, and accounts that could not be used are reported back.
const resolveBulkLanes = (req, res, next) => {
    const body = req.body || {};
    let ids = Array.isArray(body.sessionIds) && body.sessionIds.length
        ? body.sessionIds
        : (body.sessionId ? [body.sessionId] : []);
    ids = [...new Set(ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))];

    if (ids.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Missing required field: sessionIds (array) or sessionId'
        });
    }

    const lanes = [];
    const notFound = [];
    const notConnected = [];
    for (const id of ids) {
        const session = whatsappManager.getSession(id);
        if (!session) notFound.push(id);
        else if (session.connectionStatus !== 'connected') notConnected.push(id);
        else lanes.push(session);
    }

    if (lanes.length === 0) {
        const parts = [];
        if (notFound.length) parts.push(`not found: ${notFound.join(', ')}`);
        if (notConnected.length) parts.push(`not connected: ${notConnected.join(', ')}`);
        return res.status(400).json({
            success: false,
            message: `No connected account to send from${parts.length ? ` (${parts.join('; ')})` : ''}`
        });
    }

    req.lanes = lanes;
    req.laneSkipped = { notFound, notConnected };
    next();
};

// Shared handler: build the job from the request and answer with its id.
const startBulkJob = (type, buildPayload) => (req, res) => {
    try {
        const { recipients, name, delayBetweenMessages, delayJitter, typingTime } = req.body;

        const result = bulkJobManager.createJob(req.lanes, {
            type,
            recipients,
            name,
            payload: buildPayload(req.body),
            options: { delayBetweenMessages, delayJitter, typingTime }
        });

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        const skipped = req.laneSkipped || {};
        const skippedIds = [...(skipped.notFound || []), ...(skipped.notConnected || [])];

        res.json({
            success: true,
            message: `Bulk ${type} job started across ${result.job.sessionIds.length} account(s). Check status with jobId.`,
            data: {
                jobId: result.job.jobId,
                total: result.job.total,
                sessionIds: result.job.sessionIds,
                rotation: result.job.rotation,
                skippedSessions: skippedIds.length ? skippedIds : undefined,
                statusUrl: `/api/whatsapp/chats/bulk-status/${result.job.jobId}`
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Get bulk job status (with per-recipient details)
router.get('/chats/bulk-status/:jobId', (req, res) => {
    try {
        const job = bulkJobManager.getJob(req.params.jobId);

        if (!job) {
            return res.status(404).json({
                success: false,
                message: 'Job not found'
            });
        }

        res.json({
            success: true,
            data: job
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Get all bulk jobs for a session (summaries, newest first)
router.post('/chats/bulk-jobs', checkSessionExists, (req, res) => {
    try {
        res.json({
            success: true,
            data: bulkJobManager.listJobs(req.session.sessionId, 50)
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Cancel a running bulk job (stops after the send currently in flight)
router.post('/chats/bulk-jobs/:jobId/cancel', (req, res) => {
    try {
        const result = bulkJobManager.cancelJob(req.params.jobId);

        if (!result.success) {
            return res.status(result.job ? 409 : 404).json({
                success: false,
                message: result.message,
                data: result.job
            });
        }

        res.json({
            success: true,
            message: result.message,
            data: result.job
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Re-send a finished job to the recipients that did not receive it, across the
// same accounts (whichever are still connected).
router.post('/chats/bulk-jobs/:jobId/retry', checkSessionExists, (req, res) => {
    try {
        const source = bulkJobManager.getJob(req.params.jobId);

        if (!source) {
            return res.status(404).json({
                success: false,
                message: 'Job not found'
            });
        }

        const laneIds = source.sessionIds || [source.sessionId];
        if (!laneIds.includes(req.session.sessionId)) {
            return res.status(400).json({
                success: false,
                message: 'Job belongs to a different session'
            });
        }

        if (source.status === 'processing') {
            return res.status(409).json({
                success: false,
                message: 'Job is still running'
            });
        }

        const recipients = bulkJobManager.getUnsentRecipients(source.jobId);
        if (recipients.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Nothing to retry — every recipient was sent'
            });
        }

        // Reuse the accounts that are still connected; the owner leads the rotation.
        const lanes = laneIds
            .map((id) => whatsappManager.getSession(id))
            .filter((sess) => sess && sess.connectionStatus === 'connected');
        if (lanes.length === 0) {
            return res.status(409).json({
                success: false,
                message: 'None of the campaign\'s accounts are connected'
            });
        }

        const result = bulkJobManager.createJob(lanes, {
            type: source.type,
            recipients,
            name: source.name ? `${source.name} (retry)` : 'Retry',
            payload: source.payload,
            options: source.options
        });

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        res.json({
            success: true,
            message: `Retry job started for ${recipients.length} recipient(s) across ${lanes.length} account(s).`,
            data: {
                jobId: result.job.jobId,
                total: result.job.total,
                sessionIds: result.job.sessionIds,
                retryOf: source.jobId,
                statusUrl: `/api/whatsapp/chats/bulk-status/${result.job.jobId}`
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send bulk text message (Background)
router.post(
    '/chats/send-bulk',
    resolveBulkLanes,
    startBulkJob('text', ({ message }) => ({ message }))
);

// Send bulk image message (Background)
router.post(
    '/chats/send-bulk-image',
    resolveBulkLanes,
    startBulkJob('image', ({ imageUrl, caption }) => ({ imageUrl, caption }))
);

// Send bulk document message (Background)
router.post(
    '/chats/send-bulk-document',
    resolveBulkLanes,
    startBulkJob('document', ({ documentUrl, filename, mimetype, caption }) => ({
        documentUrl,
        filename,
        mimetype,
        caption
    }))
);

// Get (downloading on first request) the media of a message in history.
// Body: { sessionId, chatId, messageId }
router.post('/chats/media', checkSessionExists, async (req, res) => {
    try {
        const { chatId, messageId } = req.body;

        if (!chatId || !messageId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: chatId, messageId'
            });
        }

        const result = await req.session.getMessageMedia(chatId, messageId);
        res.status(result.success ? 200 : 404).json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Send presence update (typing indicator)
router.post('/chats/presence', checkSession, async (req, res) => {
    try {
        const { chatId, presence = 'composing' } = req.body;
        
        if (!chatId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: chatId'
            });
        }
        
        const validPresences = ['composing', 'recording', 'paused', 'available', 'unavailable'];
        if (!validPresences.includes(presence)) {
            return res.status(400).json({
                success: false,
                message: `Invalid presence. Must be one of: ${validPresences.join(', ')}`
            });
        }
        
        const result = await req.session.sendPresenceUpdate(chatId, presence);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Check if number is registered on WhatsApp
router.post('/chats/check-number', checkSession, async (req, res) => {
    try {
        const { phone } = req.body;
        
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: phone'
            });
        }
        
        const result = await req.session.isRegistered(phone);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Get profile picture
router.post('/chats/profile-picture', checkSession, async (req, res) => {
    try {
        const { phone } = req.body;
        
        if (!phone) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: phone'
            });
        }
        
        const result = await req.session.getProfilePicture(phone);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ==================== CHAT HISTORY API ====================

/**
 * Get chats overview - hanya chat yang punya pesan
 * Body: { sessionId, limit?, offset?, type? }
 * type: 'all' | 'personal' | 'group'
 */
router.post('/chats/overview', checkSession, async (req, res) => {
    try {
        const { limit = 50, offset = 0, type = 'all' } = req.body;
        const result = await req.session.getChatsOverview(limit, offset, type);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Get contacts list - semua kontak yang tersimpan
 * Body: { sessionId, limit?, offset?, search? }
 */
router.post('/contacts', checkSession, async (req, res) => {
    try {
        const { limit = 100, offset = 0, search = '' } = req.body;
        const result = await req.session.getContacts(limit, offset, search);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Get messages from any chat (personal or group)
 * Body: { sessionId, chatId, limit?, cursor? }
 * chatId: phone number (628xxx) or group id (xxx@g.us)
 */
router.post('/chats/messages', checkSession, async (req, res) => {
    try {
        const { chatId, limit = 50, cursor = null } = req.body;
        
        if (!chatId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: chatId'
            });
        }
        
        const result = await req.session.getChatMessages(chatId, limit, cursor);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Get chat info/detail (personal or group)
 * Body: { sessionId, chatId }
 */
router.post('/chats/info', checkSession, async (req, res) => {
    try {
        const { chatId } = req.body;
        
        if (!chatId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: chatId'
            });
        }
        
        const result = await req.session.getChatInfo(chatId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Mark a chat as read
 * Body: { sessionId, chatId, messageId? }
 */
router.post('/chats/mark-read', checkSession, async (req, res) => {
    try {
        const { chatId, messageId } = req.body;
        
        if (!chatId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: chatId'
            });
        }
        
        console.log(`[mark-read] chatId: ${chatId}, messageId: ${messageId || 'all'}`);
        
        const result = await req.session.markChatRead(chatId, messageId || null);
        res.json(result);
    } catch (error) {
        console.error('[mark-read] Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Internal Server Error'
        });
    }
});

// ==================== GROUP MANAGEMENT ====================

/**
 * Create a new group
 * Body: { sessionId, name, participants: ['628xxx', '628yyy'] }
 */
router.post('/groups/create', checkSession, async (req, res) => {
    try {
        const { name, participants } = req.body;
        
        if (!name || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name, participants'
            });
        }
        
        const result = await req.session.createGroup(name, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Get all participating groups
 * Body: { sessionId }
 */
router.post('/groups', checkSession, async (req, res) => {
    try {
        const result = await req.session.getAllGroups();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Get group metadata
 * Body: { sessionId, groupId }
 */
router.post('/groups/metadata', checkSession, async (req, res) => {
    try {
        const { groupId } = req.body;
        
        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: groupId'
            });
        }
        
        const result = await req.session.groupGetMetadata(groupId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Add participants to a group
 * Body: { sessionId, groupId, participants: ['628xxx', '628yyy'] }
 */
router.post('/groups/participants/add', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupAddParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Remove participants from a group
 * Body: { sessionId, groupId, participants: ['628xxx', '628yyy'] }
 */
router.post('/groups/participants/remove', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupRemoveParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Promote participants to admin
 * Body: { sessionId, groupId, participants: ['628xxx', '628yyy'] }
 */
router.post('/groups/participants/promote', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupPromoteParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Demote participants from admin
 * Body: { sessionId, groupId, participants: ['628xxx', '628yyy'] }
 */
router.post('/groups/participants/demote', checkSession, async (req, res) => {
    try {
        const { groupId, participants } = req.body;
        
        if (!groupId || !participants) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, participants'
            });
        }
        
        const result = await req.session.groupDemoteParticipants(groupId, participants);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Update group subject (name)
 * Body: { sessionId, groupId, subject }
 */
router.post('/groups/subject', checkSession, async (req, res) => {
    try {
        const { groupId, subject } = req.body;
        
        if (!groupId || !subject) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, subject'
            });
        }
        
        const result = await req.session.groupUpdateSubject(groupId, subject);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Update group description
 * Body: { sessionId, groupId, description }
 */
router.post('/groups/description', checkSession, async (req, res) => {
    try {
        const { groupId, description } = req.body;
        
        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: groupId'
            });
        }
        
        const result = await req.session.groupUpdateDescription(groupId, description);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Update group settings
 * Body: { sessionId, groupId, setting: 'announcement'|'not_announcement'|'locked'|'unlocked' }
 */
router.post('/groups/settings', checkSession, async (req, res) => {
    try {
        const { groupId, setting } = req.body;
        
        if (!groupId || !setting) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, setting'
            });
        }
        
        const result = await req.session.groupUpdateSettings(groupId, setting);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Update group profile picture
 * Body: { sessionId, groupId, imageUrl }
 */
router.post('/groups/picture', checkSession, async (req, res) => {
    try {
        const { groupId, imageUrl } = req.body;
        
        if (!groupId || !imageUrl) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: groupId, imageUrl'
            });
        }
        
        const result = await req.session.groupUpdateProfilePicture(groupId, imageUrl);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Leave a group
 * Body: { sessionId, groupId }
 */
router.post('/groups/leave', checkSession, async (req, res) => {
    try {
        const { groupId } = req.body;
        
        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: groupId'
            });
        }
        
        const result = await req.session.groupLeave(groupId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Join a group using invitation code/link
 * Body: { sessionId, inviteCode } - Can be full URL or just the code
 */
router.post('/groups/join', checkSession, async (req, res) => {
    try {
        const { inviteCode } = req.body;
        
        if (!inviteCode) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: inviteCode'
            });
        }
        
        const result = await req.session.groupJoinByInvite(inviteCode);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Get group invitation code/link
 * Body: { sessionId, groupId }
 */
router.post('/groups/invite-code', checkSession, async (req, res) => {
    try {
        const { groupId } = req.body;
        
        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: groupId'
            });
        }
        
        const result = await req.session.groupGetInviteCode(groupId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * Revoke group invitation code
 * Body: { sessionId, groupId }
 */
router.post('/groups/revoke-invite', checkSession, async (req, res) => {
    try {
        const { groupId } = req.body;
        
        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: groupId'
            });
        }
        
        const result = await req.session.groupRevokeInvite(groupId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ==================== LABELS ====================

// Get all labels
router.post('/labels', checkSession, async (req, res) => {
    try {
        const result = await req.session.getLabels();
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Create a label
router.post('/labels/create', checkSession, async (req, res) => {
    try {
        const { name, colorId = 0, labelId = null } = req.body;
        
        if (!name && !labelId) {
            return res.status(400).json({
                success: false,
                message: 'Label name is required for new label'
            });
        }

        const result = await req.session.createLabel(name, colorId, labelId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Delete a label
router.post('/labels/delete', checkSession, async (req, res) => {
    try {
        const { labelId } = req.body;
        
        if (!labelId) {
            return res.status(400).json({
                success: false,
                message: 'Label ID is required'
            });
        }

        const result = await req.session.deleteLabel(labelId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Add label to chat
router.post('/labels/chat/add', checkSession, async (req, res) => {
    try {
        const { chatId, labelId } = req.body;

        if (!chatId || !labelId) {
            return res.status(400).json({
                success: false,
                message: 'Chat ID and label ID are required'
            });
        }

        if (chatId.includes('@g.us') || chatId.match(/^\d+-\d+@g\.us$/)) {
            chatId = chatId.replace('@g.us', '') + '@g.us';
        } else if (chatId.includes('@c.us')) {
            chatId = chatId.replace('@c.us', '') + '@c.us';
        }

        const result = await req.session.addChatLabel(chatId, labelId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Remove label from chat
router.post('/labels/chat/remove', checkSession, async (req, res) => {
    try {
        const { chatId, labelId } = req.body;

        if (!chatId || !labelId) {
            return res.status(400).json({
                success: false,
                message: 'Chat ID and label ID are required'
            });
        }

        if (chatId.includes('@g.us') || chatId.match(/^\d+-\d+@g\.us$/)) {
            chatId = chatId.replace('@g.us', '') + '@g.us';
        } else if (chatId.includes('@c.us')) {
            chatId = chatId.replace('@c.us', '') + '@c.us';
        }

        const result = await req.session.removeChatLabel(chatId, labelId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Get labels for a chat
router.post('/labels/chat', checkSession, async (req, res) => {
    try {
        const { chatId } = req.body;

        if (!chatId) {
            return res.status(400).json({
                success: false,
                message: 'Chat ID is required'
            });
        }

        if (chatId.includes('@g.us') || chatId.match(/^\d+-\d+@g\.us$/)) {
            chatId = chatId.replace('@g.us', '') + '@g.us';
        } else if (chatId.includes('@c.us')) {
            chatId = chatId.replace('@c.us', '') + '@c.us';
        }

        const result = await req.session.getChatLabels(chatId);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = router;