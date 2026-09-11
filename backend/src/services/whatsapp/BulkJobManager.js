const path = require('path');
const fs = require('fs');
const wsManager = require('../websocket/WebSocketManager');

/** Hard cap on recipients per job (override with BULK_MAX_RECIPIENTS). */
const MAX_RECIPIENTS = Number(process.env.BULK_MAX_RECIPIENTS) || 100;
/** Jobs kept per session in the history file (oldest are dropped). */
const MAX_JOBS_PER_SESSION = Number(process.env.BULK_MAX_JOBS_PER_SESSION) || 100;
/** How long a running job waits for a dropped session to come back (ms). */
const RECONNECT_WAIT_MS = Number(process.env.BULK_RECONNECT_WAIT_MS) || 60_000;
/** Minimum gap between history-file writes while a job is running (ms). */
const PERSIST_THROTTLE_MS = 2_000;

const TERMINAL = new Set(['completed', 'cancelled', 'interrupted']);

/**
 * Bulk Job Manager (Singleton)
 *
 * Owns every bulk-send job: validation, the background send loop, progress
 * broadcasting (WebSocket + webhooks) and on-disk history. Jobs live in
 * `sessions/<sessionId>/bulk-jobs.json` next to the session's config, so a
 * restart keeps the history and marks whatever was mid-flight as
 * `interrupted` instead of silently forgetting it.
 *
 * Job status lifecycle:
 *   processing -> completed    every recipient attempted (sent or failed)
 *              -> cancelled    cancel requested; remaining marked `skipped`
 *              -> interrupted  session stayed disconnected / server restarted
 */
class BulkJobManager {
    constructor() {
        this.jobs = new Map(); // jobId -> job
        this.sessionsFolder = path.join(process.cwd(), 'sessions');
        this.persistTimers = new Map(); // sessionId -> { timer, last }
        this._loadAll();
    }

    // ==================== PUBLIC API ====================

    /**
     * Validate the request and start a job in the background.
     * @param {WhatsAppSession} session - connected session that will send
     * @param {Object} input
     * @param {'text'|'image'|'document'} input.type
     * @param {string[]} input.recipients - phone numbers or JIDs
     * @param {Object} input.payload - type-specific content (message / imageUrl+caption / documentUrl+filename+mimetype+caption)
     * @param {Object} [input.options] - { delayBetweenMessages, delayJitter, typingTime }
     * @param {string} [input.name] - optional label shown in the dashboard
     * @returns {{ success: boolean, message?: string, job?: Object }}
     */
    createJob(session, input) {
        const validation = this._validate(input);
        if (!validation.success) return validation;

        const { type, recipients, payload, options, name } = validation.data;
        const jobId = `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        const now = new Date().toISOString();

        const job = {
            jobId,
            sessionId: session.sessionId,
            type,
            name: name || null,
            status: 'processing',
            total: recipients.length,
            sent: 0,
            failed: 0,
            skipped: 0,
            progress: 0,
            payload,
            options,
            recipients,
            details: [],
            createdAt: now,
            startedAt: now,
            completedAt: null,
            error: null,
            // runtime-only, never persisted
            _cancelRequested: false
        };

        this.jobs.set(jobId, job);
        this._persist(job.sessionId, true);

        // Fire and forget — the HTTP response must not wait for the sends.
        this._run(job, session).catch((error) => {
            console.error(`[${job.sessionId}] Bulk job ${jobId} crashed:`, error);
            this._finish(job, session, 'interrupted', error.message);
        });

        return { success: true, job: this.toPublic(job) };
    }

    /** Full job (with per-recipient details), or undefined. */
    getJob(jobId) {
        const job = this.jobs.get(jobId);
        return job ? this.toPublic(job) : undefined;
    }

    /** Newest-first summaries (no details) for one session. */
    listJobs(sessionId, limit = 50) {
        const jobs = [];
        for (const job of this.jobs.values()) {
            if (job.sessionId === sessionId) jobs.push(this.toSummary(job));
        }
        jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return jobs.slice(0, limit);
    }

    /**
     * Ask a running job to stop after the send currently in flight.
     * @returns {{ success: boolean, message: string, job?: Object }}
     */
    cancelJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return { success: false, message: 'Job not found' };
        if (TERMINAL.has(job.status)) {
            return { success: false, message: `Job already ${job.status}`, job: this.toPublic(job) };
        }
        job._cancelRequested = true;
        return { success: true, message: 'Cancellation requested', job: this.toPublic(job) };
    }

    /** Recipients that did not get the message (failed or skipped) — used by "retry". */
    getUnsentRecipients(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return null;
        return job.details
            .filter((d) => d.status !== 'sent')
            .map((d) => d.recipient);
    }

    /** Public view: everything except runtime flags. */
    toPublic(job) {
        const { _cancelRequested, ...rest } = job;
        return { ...rest, cancelRequested: Boolean(_cancelRequested) };
    }

    /** List view: drop the heavy arrays. */
    toSummary(job) {
        const { details, recipients, ...rest } = this.toPublic(job);
        return rest;
    }

    // ==================== VALIDATION ====================

    _validate(input) {
        const { type, payload = {}, name } = input;
        const options = input.options || {};

        if (!['text', 'image', 'document'].includes(type)) {
            return { success: false, message: `Unsupported bulk type: ${type}` };
        }

        if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
            return { success: false, message: 'Missing required field: recipients (array of phone numbers)' };
        }

        // Trim, drop blanks, de-duplicate while preserving order.
        const seen = new Set();
        const recipients = [];
        for (const raw of input.recipients) {
            if (typeof raw !== 'string') continue;
            const value = raw.trim();
            if (!value || seen.has(value)) continue;
            seen.add(value);
            recipients.push(value);
        }
        if (recipients.length === 0) {
            return { success: false, message: 'recipients contains no valid entries' };
        }
        if (recipients.length > MAX_RECIPIENTS) {
            return { success: false, message: `Maximum ${MAX_RECIPIENTS} recipients per request` };
        }

        let cleanPayload;
        if (type === 'text') {
            if (!payload.message || typeof payload.message !== 'string' || !payload.message.trim()) {
                return { success: false, message: 'Missing required field: message' };
            }
            cleanPayload = { message: payload.message };
        } else if (type === 'image') {
            if (!payload.imageUrl) {
                return { success: false, message: 'Missing required field: imageUrl' };
            }
            cleanPayload = { imageUrl: payload.imageUrl, caption: payload.caption || '' };
        } else {
            if (!payload.documentUrl || !payload.filename) {
                return { success: false, message: 'Missing required fields: documentUrl, filename' };
            }
            cleanPayload = {
                documentUrl: payload.documentUrl,
                filename: payload.filename,
                mimetype: payload.mimetype || 'application/pdf',
                caption: payload.caption || ''
            };
        }

        const num = (value, fallback, max) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) return fallback;
            return Math.min(n, max);
        };

        return {
            success: true,
            data: {
                type,
                recipients,
                payload: cleanPayload,
                name: typeof name === 'string' ? name.slice(0, 120) : null,
                options: {
                    delayBetweenMessages: num(options.delayBetweenMessages, 1000, 600_000),
                    delayJitter: num(options.delayJitter, 0, 600_000),
                    typingTime: num(options.typingTime, 0, 60_000)
                }
            }
        };
    }

    // ==================== SEND LOOP ====================

    async _run(job, session) {
        const { delayBetweenMessages, delayJitter, typingTime } = job.options;

        for (let i = 0; i < job.recipients.length; i++) {
            if (job._cancelRequested) {
                this._skipRemaining(job, i, 'Cancelled');
                return this._finish(job, session, 'cancelled');
            }

            // A dropped socket mid-campaign should pause, not burn through the list.
            if (session.connectionStatus !== 'connected') {
                const back = await this._waitForConnection(session, job);
                if (job._cancelRequested) {
                    this._skipRemaining(job, i, 'Cancelled');
                    return this._finish(job, session, 'cancelled');
                }
                if (!back) {
                    this._skipRemaining(job, i, 'Session disconnected');
                    return this._finish(job, session, 'interrupted', 'Session disconnected');
                }
            }

            const recipient = job.recipients[i];
            let result;
            try {
                result = await this._send(session, job, recipient, typingTime);
            } catch (error) {
                result = { success: false, message: error.message };
            }

            if (result?.success) {
                job.sent++;
                job.details.push({
                    recipient,
                    status: 'sent',
                    messageId: result.data?.messageId,
                    timestamp: new Date().toISOString()
                });
            } else {
                job.failed++;
                job.details.push({
                    recipient,
                    status: 'failed',
                    error: result?.message || 'Unknown error',
                    timestamp: new Date().toISOString()
                });
            }

            job.progress = Math.round(((i + 1) / job.total) * 100);
            this._emitProgress(job);
            this._persist(job.sessionId);

            if (i < job.recipients.length - 1) {
                const jitter = delayJitter > 0 ? Math.floor(Math.random() * (delayJitter + 1)) : 0;
                await this._sleep(delayBetweenMessages + jitter, job);
            }
        }

        this._finish(job, session, 'completed');
    }

    _send(session, job, recipient, typingTime) {
        const p = job.payload;
        switch (job.type) {
            case 'text':
                return session.sendTextMessage(recipient, p.message, typingTime);
            case 'image':
                return session.sendImage(recipient, p.imageUrl, p.caption, typingTime);
            case 'document':
                return session.sendDocument(recipient, p.documentUrl, p.filename, p.mimetype, p.caption, typingTime);
            default:
                return Promise.resolve({ success: false, message: `Unsupported type ${job.type}` });
        }
    }

    _skipRemaining(job, fromIndex, reason) {
        const now = new Date().toISOString();
        for (let i = fromIndex; i < job.recipients.length; i++) {
            job.skipped++;
            job.details.push({ recipient: job.recipients[i], status: 'skipped', error: reason, timestamp: now });
        }
        job.progress = 100;
    }

    _finish(job, session, status, error = null) {
        if (TERMINAL.has(job.status)) return;
        job.status = status;
        job.error = error;
        job.completedAt = new Date().toISOString();
        job._cancelRequested = false;
        this._persist(job.sessionId, true);

        const summary = this.toSummary(job);
        wsManager.emitToSession(job.sessionId, 'bulk.completed', { job: summary });
        if (session && typeof session._sendWebhook === 'function') {
            session._sendWebhook('bulk.completed', summary);
        }
        console.log(
            `📤 Bulk ${job.type} job ${job.jobId} ${status}. Sent: ${job.sent}, Failed: ${job.failed}, Skipped: ${job.skipped}`
        );
    }

    _emitProgress(job) {
        wsManager.emitToSession(job.sessionId, 'bulk.progress', {
            job: this.toSummary(job),
            last: job.details[job.details.length - 1] || null
        });
    }

    /** Poll the session until it reconnects, gives up after RECONNECT_WAIT_MS. */
    async _waitForConnection(session, job) {
        const deadline = Date.now() + RECONNECT_WAIT_MS;
        while (Date.now() < deadline) {
            if (job._cancelRequested) return false;
            if (session.connectionStatus === 'connected') return true;
            await this._sleep(1000, job);
        }
        return session.connectionStatus === 'connected';
    }

    /** Sleep in short slices so a cancel does not wait out a long delay. */
    async _sleep(ms, job) {
        const step = 200;
        let remaining = ms;
        while (remaining > 0) {
            if (job._cancelRequested) return;
            const slice = Math.min(step, remaining);
            await new Promise((resolve) => setTimeout(resolve, slice));
            remaining -= slice;
        }
    }

    // ==================== PERSISTENCE ====================

    _historyFile(sessionId) {
        return path.join(this.sessionsFolder, sessionId, 'bulk-jobs.json');
    }

    /**
     * Write the session's job history. Throttled while jobs are running so a
     * 100-recipient job does not rewrite the file 100 times a minute; `force`
     * is used for create/finish so those states always land on disk.
     */
    _persist(sessionId, force = false) {
        const entry = this.persistTimers.get(sessionId) || { timer: null, last: 0 };
        const write = () => {
            entry.timer = null;
            entry.last = Date.now();
            this._writeHistory(sessionId);
        };

        if (force) {
            if (entry.timer) clearTimeout(entry.timer);
            write();
        } else if (!entry.timer) {
            const wait = Math.max(0, PERSIST_THROTTLE_MS - (Date.now() - entry.last));
            entry.timer = setTimeout(write, wait);
        }
        this.persistTimers.set(sessionId, entry);
    }

    _writeHistory(sessionId) {
        try {
            const folder = path.join(this.sessionsFolder, sessionId);
            // The session folder disappears on logout — its history goes with it.
            if (!fs.existsSync(folder)) return;

            const jobs = [];
            for (const job of this.jobs.values()) {
                if (job.sessionId === sessionId) jobs.push(this.toPublic(job));
            }
            jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            // Evict the oldest finished jobs beyond the cap (never a running one).
            const keep = [];
            for (const job of jobs) {
                if (keep.length < MAX_JOBS_PER_SESSION || !TERMINAL.has(job.status)) keep.push(job);
                else this.jobs.delete(job.jobId);
            }

            const file = this._historyFile(sessionId);
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(keep, null, 2));
            fs.renameSync(tmp, file);
        } catch (error) {
            console.error(`[${sessionId}] Could not save bulk job history:`, error.message);
        }
    }

    /** Restore history for every session folder; mark in-flight jobs as interrupted. */
    _loadAll() {
        try {
            if (!fs.existsSync(this.sessionsFolder)) return;
            for (const sessionId of fs.readdirSync(this.sessionsFolder)) {
                const file = this._historyFile(sessionId);
                if (!fs.existsSync(file)) continue;
                let jobs;
                try {
                    jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
                } catch (error) {
                    console.error(`[${sessionId}] Corrupt bulk-jobs.json ignored:`, error.message);
                    continue;
                }
                if (!Array.isArray(jobs)) continue;

                let interrupted = 0;
                for (const stored of jobs) {
                    if (!stored?.jobId) continue;
                    const job = {
                        ...stored,
                        recipients: stored.recipients || [],
                        details: stored.details || [],
                        skipped: stored.skipped || 0,
                        _cancelRequested: false
                    };
                    delete job.cancelRequested;
                    if (!TERMINAL.has(job.status)) {
                        this._skipRemaining(job, job.details.length, 'Server restarted');
                        job.status = 'interrupted';
                        job.error = 'Server restarted';
                        job.completedAt = new Date().toISOString();
                        interrupted++;
                    }
                    this.jobs.set(job.jobId, job);
                }
                if (interrupted > 0) {
                    console.log(`⚠️ [${sessionId}] ${interrupted} bulk job(s) were interrupted by a restart`);
                    this._persist(sessionId, true);
                }
            }
        } catch (error) {
            console.error('Could not load bulk job history:', error.message);
        }
    }
}

module.exports = new BulkJobManager();
