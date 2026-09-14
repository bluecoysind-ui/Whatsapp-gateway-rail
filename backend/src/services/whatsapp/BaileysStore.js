/**
 * Custom in-memory store for Baileys
 * Optimized version with pre-computed caches for fast queries
 */
/**
 * Normalize any WhatsApp timestamp to whole Unix SECONDS.
 * Baileys delivers messageTimestamp as a number for live messages but as a
 * protobuf Long ({ low, high }) for history messages — the Long is truthy, so
 * unguarded it reaches the UI and becomes "Invalid Date".
 */
function toUnixSeconds(ts) {
  if (ts == null) return 0;
  let n;
  if (typeof ts === 'number') n = ts;
  else if (typeof ts === 'string') n = Number(ts);
  else if (typeof ts === 'object') {
    if (typeof ts.toNumber === 'function') n = ts.toNumber();
    else if (typeof ts.low === 'number') n = (ts.high || 0) * 4294967296 + (ts.low >>> 0);
    else n = Number(ts);
  } else n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Some sources give milliseconds — fold down to seconds.
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

class BaileysStore {
  constructor(sessionId = null) {
    this.sessionId = sessionId;
    // History-sync progress, surfaced to the dashboard as a progress bar.
    this.syncState = { active: false, progress: 0, isLatest: false, chats: 0, contacts: 0, messages: 0, startedAt: null, updatedAt: null };
    
    // Core data stores
    this.chats = new Map();
    this.contacts = new Map();
    this.messages = new Map();
    this.groupMetadata = new Map();
    
    // LID identity mapping registry (key: JID/LID/PN -> { lid, pn, jid })
    this.lidMap = new Map();
    
    // Optimized caches for fast queries
    this.chatsOverview = new Map(); // Pre-computed chat overview
    this.profilePictures = new Map(); // Cached profile pictures
    this.contactsCache = new Map(); // Cached contacts with profile pics
    
    // Sorted cache arrays (avoid re-sorting on every request)
    this._sortedOverviewCache = null; // Cached sorted overview array
    this._sortedContactsCache = null; // Cached sorted contacts array
    
    // Label storage
    this.labels = new Map(); // labelId -> { id, name, color, predefinedId }
    this.labelAssociations = new Map(); // chatId -> Set<labelId>
    
    // Media files tracking: messageId -> filePath
    this.mediaFiles = new Map();
    
    // Cache timestamps
    this.lastOverviewUpdate = 0;
    this.lastContactsUpdate = 0;
    this.cacheTimeout = 30000; // 30 seconds cache validity
  }

  /**
   * Bind store to Baileys socket events
   */
  // ---- history-sync ingestion (shared by messaging-history.set) ----

  _ingestHistoryChat(chat) {
    if (!chat || !chat.id) return;
    let resolvedId = chat.id;
    if (chat.id.endsWith('@lid')) {
      const resolved = this.resolveIdentity(chat.id);
      if (resolved && resolved.jid) resolvedId = resolved.jid;
    }
    chat.id = resolvedId;
    this.chats.set(resolvedId, { ...this.chats.get(resolvedId), ...chat });
    this._updateSingleChatOverview(resolvedId);
  }

  /**
   * Register the LID→phone identity carried on a contact record.
   * Baileys v7 exposes the mapping two ways:
   *   - id is a PN JID + a `lid` field, or
   *   - id is a @lid + a `phoneNumber` field (the real phone JID).
   * Wiring both up lets @lid chats/messages migrate to the real phone number.
   */
  _registerContactIdentity(contact) {
    if (!contact || !contact.id) return;
    if (contact.lid && !contact.id.endsWith('@lid')) {
      this.registerIdentity(contact.lid, contact.id);
    }
    if (contact.id.endsWith('@lid') && contact.phoneNumber &&
        (contact.phoneNumber.endsWith('@s.whatsapp.net') || contact.phoneNumber.endsWith('@c.us'))) {
      this.registerIdentity(contact.id, contact.phoneNumber);
    }
  }

  _ingestHistoryContact(contact) {
    if (!contact || !contact.id) return;
    this._registerContactIdentity(contact);
    let resolvedId = contact.id;
    if (contact.id.endsWith('@lid')) {
      const resolved = this.resolveIdentity(contact.id);
      if (resolved && resolved.jid) resolvedId = resolved.jid;
    }
    contact.id = resolvedId;
    const existing = this.contacts.get(resolvedId) || {};
    this.contacts.set(resolvedId, { ...existing, ...contact });
  }

  _ingestHistoryMessage(msg) {
    if (!msg || !msg.key || !msg.key.remoteJid || !msg.key.id) return;
    let resolvedId = msg.key.remoteJid;
    if (resolvedId.endsWith('@lid')) {
      const altJid = msg.key.remoteJidAlt || msg.remoteJidAlt;
      if (altJid && altJid.endsWith('@s.whatsapp.net')) {
        this.registerIdentity(resolvedId, altJid);
        resolvedId = altJid;
        msg.key.remoteJid = resolvedId;
      } else {
        const resolved = this.resolveIdentity(resolvedId);
        if (resolved && resolved.jid) {
          resolvedId = resolved.jid;
          msg.key.remoteJid = resolvedId;
        }
      }
    }
    if (msg.key.participant && msg.key.participant.endsWith('@lid')) {
      const resolved = this.resolveIdentity(msg.key.participant);
      if (resolved && resolved.jid) msg.key.participant = resolved.jid;
    }
    // Persist pushName as the contact's display name for any non-group chat —
    // including unresolved @lid chats, so the chat list shows a name instead of a
    // raw LID even when the most recent message is outgoing (fromMe).
    if (msg.pushName && resolvedId && !resolvedId.endsWith('@g.us')) {
      const existing = this.contacts.get(resolvedId) || {};
      if (!existing.notify || !existing.name) {
        this.contacts.set(resolvedId, { ...existing, id: resolvedId, notify: msg.pushName });
      }
    }
    if (!this.messages.has(resolvedId)) this.messages.set(resolvedId, new Map());
    this.messages.get(resolvedId).set(msg.key.id, msg);
    this._updateSingleChatOverview(resolvedId, msg);
  }

  bind(ev) {
    // Baileys v7 delivers the initial history sync (and syncFullHistory batches)
    // as ONE event: 'messaging-history.set'. The older per-collection events
    // ('chats.set' / 'contacts.set' / 'messages.set') below are never emitted by
    // v7 — this handler is what actually populates chats, contacts and messages.
    ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress }) => {
      if (Array.isArray(contacts)) for (const c of contacts) this._ingestHistoryContact(c);
      if (Array.isArray(chats)) for (const c of chats) this._ingestHistoryChat(c);
      if (Array.isArray(messages)) for (const m of messages) this._ingestHistoryMessage(m);
      this._invalidateContactsCache();
      this._invalidateOverviewCache();

      const st = this.syncState;
      if (!st.startedAt) st.startedAt = Date.now();
      st.chats += chats?.length || 0;
      st.contacts += contacts?.length || 0;
      st.messages += messages?.length || 0;
      if (typeof progress === 'number') st.progress = Math.max(st.progress, Math.round(progress));
      st.isLatest = Boolean(isLatest);
      st.active = !st.isLatest && st.progress < 100;
      st.updatedAt = Date.now();
      if (!st.active) st.progress = 100;

      console.log(
        `\uD83D\uDCDA [${this.sessionId}] history sync: +${chats?.length || 0} chats, ` +
        `+${contacts?.length || 0} contacts, +${messages?.length || 0} messages ` +
        `(latest=${isLatest}, progress=${progress ?? '?'})`
      );
    });

    // Handle chat updates
    ev.on('chats.set', ({ chats }) => {
      for (const chat of chats) {
        let resolvedId = chat.id;
        if (chat.id && chat.id.endsWith('@lid')) {
          const resolved = this.resolveIdentity(chat.id);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
          }
        }
        chat.id = resolvedId;
        this.chats.set(resolvedId, chat);
      }
      this._invalidateOverviewCache();
    });

    ev.on('chats.upsert', (chats) => {
      for (const chat of chats) {
        let resolvedId = chat.id;
        if (chat.id && chat.id.endsWith('@lid')) {
          const resolved = this.resolveIdentity(chat.id);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
          }
        }
        chat.id = resolvedId;
        this.chats.set(resolvedId, { ...this.chats.get(resolvedId), ...chat });
        this._updateSingleChatOverview(resolvedId);
      }
    });

    ev.on('chats.update', (updates) => {
      for (const update of updates) {
        let resolvedId = update.id;
        if (update.id && update.id.endsWith('@lid')) {
          const resolved = this.resolveIdentity(update.id);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
          }
        }
        update.id = resolvedId;
        const existing = this.chats.get(resolvedId);
        if (existing) {
          this.chats.set(resolvedId, { ...existing, ...update });
          this._updateSingleChatOverview(resolvedId);
        }
      }
    });

    ev.on('chats.delete', (ids) => {
      for (const id of ids) {
        let resolvedId = id;
        if (id && id.endsWith('@lid')) {
          const resolved = this.resolveIdentity(id);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
          }
        }
        this.chats.delete(resolvedId);
        this.chatsOverview.delete(resolvedId);
        this.messages.delete(resolvedId);
      }
    });

    // Handle contact updates
    ev.on('contacts.set', ({ contacts }) => {
      for (const contact of contacts) {
        // Register identity mapping from PN-JID+lid OR @lid+phoneNumber (v7)
        this._registerContactIdentity(contact);

        // Resolve LID to JID before storing
        let resolvedId = contact.id;
        if (contact.id && contact.id.endsWith('@lid')) {
          const resolved = this.resolveIdentity(contact.id);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
          }
        }
        contact.id = resolvedId;

        // Upsert: merge with existing data
        const existing = this.contacts.get(resolvedId) || {};
        this.contacts.set(resolvedId, { ...existing, ...contact });
      }
      this._invalidateContactsCache();
    });

    ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        // Register identity mapping from PN-JID+lid OR @lid+phoneNumber (v7)
        this._registerContactIdentity(contact);

        // Resolve LID to JID before storing
        let resolvedId = contact.id;
        if (contact.id && contact.id.endsWith('@lid')) {
          const resolved = this.resolveIdentity(contact.id);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
          }
        }
        contact.id = resolvedId;

        // Upsert: merge with existing data
        const existing = this.contacts.get(resolvedId) || {};
        this.contacts.set(resolvedId, { ...existing, ...contact });
      }
      this._invalidateContactsCache();
    });

    ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        // Resolve LID to JID
        let resolvedId = update.id;
        if (update.id && update.id.endsWith('@lid')) {
          const resolved = this.resolveIdentity(update.id);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
          }
        }

        // Try resolved ID first, then fallback to original LID key
        let existing = this.contacts.get(resolvedId);
        if (!existing && resolvedId !== update.id) {
          existing = this.contacts.get(update.id);
          if (existing) {
            this.contacts.delete(update.id); // Remove old LID key
          }
        }

        if (existing) {
          update.id = resolvedId;
          const merged = { ...existing, ...update };
          this.contacts.set(resolvedId, merged);
          if (merged.lid && !resolvedId.endsWith('@lid')) {
            this.registerIdentity(merged.lid, resolvedId);
          }
        }
      }
      this._invalidateContactsCache();
    });

    // Handle message updates - OPTIMIZED
    ev.on('messages.set', ({ messages, isLatest }) => {
      for (const msg of messages) {
        // Skip null/invalid messages
        if (!msg || !msg.key || !msg.key.remoteJid || !msg.key.id) continue;
        
        let resolvedId = msg.key.remoteJid;
        if (resolvedId.endsWith('@lid')) {
          // Use remoteJidAlt (Baileys v7) to discover LID→JID mapping
          const altJid = msg.key.remoteJidAlt || msg.remoteJidAlt;
          if (altJid && altJid.endsWith('@s.whatsapp.net')) {
            this.registerIdentity(resolvedId, altJid);
            resolvedId = altJid;
            msg.key.remoteJid = resolvedId;
          } else {
            const resolved = this.resolveIdentity(resolvedId);
            if (resolved && resolved.jid) {
              resolvedId = resolved.jid;
              msg.key.remoteJid = resolvedId;
            }
          }
        }
        
        if (msg.key.participant && msg.key.participant.endsWith('@lid')) {
          const resolved = this.resolveIdentity(msg.key.participant);
          if (resolved && resolved.jid) {
            msg.key.participant = resolved.jid;
          }
        }

        // Store pushName as contact notify (also for @lid chats) so the chat list
        // shows a name instead of a raw LID even when the last message is outgoing.
        if (msg.pushName && resolvedId && !resolvedId.endsWith('@g.us')) {
          const existing = this.contacts.get(resolvedId) || {};
          if (!existing.notify || !existing.name) {
            this.contacts.set(resolvedId, { ...existing, id: resolvedId, notify: msg.pushName });
          }
        }
        
        if (!this.messages.has(resolvedId)) {
          this.messages.set(resolvedId, new Map());
        }
        this.messages.get(resolvedId).set(msg.key.id, msg);
        this._updateSingleChatOverview(resolvedId, msg);
      }
    });

    ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        // Skip null/invalid messages
        if (!msg || !msg.key || !msg.key.remoteJid || !msg.key.id) continue;
        
        let resolvedId = msg.key.remoteJid;
        if (resolvedId.endsWith('@lid')) {
          // Use remoteJidAlt (Baileys v7) to discover LID→JID mapping
          const altJid = msg.key.remoteJidAlt || msg.remoteJidAlt;
          if (altJid && altJid.endsWith('@s.whatsapp.net')) {
            this.registerIdentity(resolvedId, altJid);
            resolvedId = altJid;
            msg.key.remoteJid = resolvedId;
          } else {
            const resolved = this.resolveIdentity(resolvedId);
            if (resolved && resolved.jid) {
              resolvedId = resolved.jid;
              msg.key.remoteJid = resolvedId;
            }
          }
        }
        
        if (msg.key.participant && msg.key.participant.endsWith('@lid')) {
          const resolved = this.resolveIdentity(msg.key.participant);
          if (resolved && resolved.jid) {
            msg.key.participant = resolved.jid;
          }
        }

        // Store pushName as contact notify (also for @lid chats) so the chat list
        // shows a name instead of a raw LID even when the last message is outgoing.
        if (msg.pushName && resolvedId && !resolvedId.endsWith('@g.us')) {
          const existing = this.contacts.get(resolvedId) || {};
          if (!existing.notify || !existing.name) {
            this.contacts.set(resolvedId, { ...existing, id: resolvedId, notify: msg.pushName });
          }
        }
        
        if (!this.messages.has(resolvedId)) {
          this.messages.set(resolvedId, new Map());
        }
        this.messages.get(resolvedId).set(msg.key.id, msg);
        this._updateSingleChatOverview(resolvedId, msg);
      }
    });

    ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        // Skip invalid updates
        if (!key || !key.remoteJid || !key.id) continue;
        
        let resolvedId = key.remoteJid;
        if (resolvedId.endsWith('@lid')) {
          const resolved = this.resolveIdentity(resolvedId);
          if (resolved && resolved.jid) {
            resolvedId = resolved.jid;
            key.remoteJid = resolvedId;
          }
        }
        
        const chatMessages = this.messages.get(resolvedId);
        if (chatMessages) {
          const existing = chatMessages.get(key.id);
          if (existing) {
            chatMessages.set(key.id, { ...existing, ...update });
          }
        }
      }
    });

    ev.on('messages.delete', (item) => {
      if ('keys' in item) {
        for (const key of item.keys) {
          // Skip invalid keys
          if (!key || !key.remoteJid) continue;
          
          let resolvedId = key.remoteJid;
          if (resolvedId.endsWith('@lid')) {
            const resolved = this.resolveIdentity(resolvedId);
            if (resolved && resolved.jid) {
              resolvedId = resolved.jid;
              key.remoteJid = resolvedId;
            }
          }
          
          const chatMessages = this.messages.get(resolvedId);
          if (chatMessages) {
            chatMessages.delete(key.id);
            // Also delete associated media file
            this._deleteMediaFile(key.id);
          }
        }
      }
    });

    // Handle group metadata
    ev.on('groups.upsert', (groups) => {
      for (const group of groups) {
        this.groupMetadata.set(group.id, group);
      }
    });

    ev.on('groups.update', (updates) => {
      for (const update of updates) {
        const existing = this.groupMetadata.get(update.id);
        if (existing) {
          this.groupMetadata.set(update.id, { ...existing, ...update });
        }
      }
    });

    // Handle label events
    ev.on('labels.edit', (label) => {
      if (label.deleted) {
        this.labels.delete(label.id);
        // Remove associations for deleted label
        for (const [chatId, labelSet] of this.labelAssociations.entries()) {
          labelSet.delete(label.id);
          if (labelSet.size === 0) this.labelAssociations.delete(chatId);
        }
      } else {
        this.labels.set(label.id, {
          id: label.id,
          name: label.name,
          color: label.color,
          predefinedId: label.predefinedId || null
        });
      }
    });

    ev.on('labels.association', ({ association, type }) => {
      if (!association) return;
      const chatId = association.chatId;
      const labelId = association.labelId;
      if (!chatId || !labelId) return;

      if (!this.labelAssociations.has(chatId)) {
        this.labelAssociations.set(chatId, new Set());
      }

      if (type === 'add') {
        this.labelAssociations.get(chatId).add(labelId);
      } else if (type === 'remove') {
        this.labelAssociations.get(chatId).delete(labelId);
        if (this.labelAssociations.get(chatId).size === 0) {
          this.labelAssociations.delete(chatId);
        }
      }
    });
  }

  /**
   * Find a usable display name from a chat's stored messages.
   * Scans messages (newest first) for any incoming message that carries a
   * pushName. This recovers a human-readable name for @lid/unnamed chats even
   * when the most recent message is outgoing (fromMe carries no pushName).
   */
  _findPushName(chatId) {
    const chatMessages = this.messages.get(chatId);
    if (!chatMessages || chatMessages.size === 0) return null;
    const messagesArray = Array.from(chatMessages.values())
      .filter(m => m && m.key && !m.key.fromMe && m.pushName);
    if (messagesArray.length === 0) return null;
    messagesArray.sort((a, b) => toUnixSeconds(b.messageTimestamp) - toUnixSeconds(a.messageTimestamp));
    return messagesArray[0].pushName || null;
  }

  /**
   * Update single chat overview (called on message events)
   */
  _updateSingleChatOverview(chatId, newMessage = null) {
    const chat = this.chats.get(chatId);
    const chatMessages = this.messages.get(chatId);
    
    if (!chatMessages || chatMessages.size === 0) {
      this.chatsOverview.delete(chatId);
      return;
    }

    // Find latest message
    let latestMessage = newMessage;
    if (!latestMessage) {
      const messagesArray = Array.from(chatMessages.values()).filter(m => m != null && m !== undefined && m.key != null);
      if (messagesArray.length === 0) {
        this.chatsOverview.delete(chatId);
        return;
      }
      const getTimestamp = (msg) => (msg ? toUnixSeconds(msg.messageTimestamp) : 0);
      messagesArray.sort((a, b) => getTimestamp(b) - getTimestamp(a));
      latestMessage = messagesArray[0];
    }

    // Skip if no valid message found
    if (!latestMessage) {
      return;
    }

    const contact = this.contacts.get(chatId);
    const isGroup = chatId.endsWith('@g.us');
    const groupMeta = isGroup ? this.groupMetadata.get(chatId) : null;

    // Build name: different logic for groups vs personal chats
    let chatName;
    if (isGroup) {
      // Groups: use group subject or chat name (never pushName — that's a person's name)
      chatName = groupMeta?.subject || chat?.name;
    } else {
      // Personal chats: contact name → notify → verifiedName → pushName from the
      // latest OR any earlier message → chat name (avoids raw LID/phone digits).
      chatName = contact?.name || contact?.notify || contact?.verifiedName
        || latestMessage?.pushName || this._findPushName(chatId) || chat?.name;
    }
    if (!chatName) {
      // Fall back to the resolved phone number from the identity cache; only if that
      // fails do we use the raw JID/local-id part.
      chatName = this.resolvePhoneNumber(chatId) || chatId.split('@')[0];
    }

    this.chatsOverview.set(chatId, {
      id: chatId,
      name: chatName,
      isGroup,
      unreadCount: chat?.unreadCount || 0,
      lastMessage: {
        id: latestMessage?.key?.id,
        timestamp: toUnixSeconds(latestMessage?.messageTimestamp),
        preview: this._extractMessagePreview(latestMessage),
        fromMe: latestMessage?.key?.fromMe || false
      },
      profilePicture: this.profilePictures.get(chatId) || null,
      conversationTimestamp: toUnixSeconds(chat?.conversationTimestamp) || toUnixSeconds(latestMessage?.messageTimestamp)
    });

    // Invalidate sorted cache since overview data changed
    this._sortedOverviewCache = null;
  }

  /**
   * Extract message preview text
   */
  _extractMessagePreview(message) {
    if (!message?.message) return '';
    
    const msg = message.message;
    
    if (msg.conversation) return msg.conversation.substring(0, 100);
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text.substring(0, 100);
    if (msg.imageMessage) return '📷 Image';
    if (msg.videoMessage) return '🎥 Video';
    if (msg.audioMessage) return '🎵 Audio';
    if (msg.documentMessage) return `📄 ${msg.documentMessage.fileName || 'Document'}`;
    if (msg.stickerMessage) return '🎭 Sticker';
    if (msg.contactMessage) return `👤 Contact: ${msg.contactMessage.displayName}`;
    if (msg.locationMessage) return '📍 Location';
    if (msg.buttonsMessage) return msg.buttonsMessage.contentText || 'Buttons';
    if (msg.templateMessage) return 'Template Message';
    if (msg.listMessage) return msg.listMessage.title || 'List';
    if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3) {
      const pollMsg = msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3;
      return `📊 ${pollMsg.name || 'Poll'}`;
    }
    if (msg.pollUpdateMessage) return '📊 Poll vote';
    
    return 'Message';
  }

  /**
   * Invalidate overview cache
   */
  _invalidateOverviewCache() {
    this.lastOverviewUpdate = 0;
    this._sortedOverviewCache = null;
  }

  /**
   * Invalidate contacts cache
   */
  _invalidateContactsCache() {
    this.lastContactsUpdate = 0;
    this.contactsCache.clear();
    this._sortedContactsCache = null;
  }

  /**
   * Set profile picture (called from session)
   */
  setProfilePicture(jid, url) {
    this.profilePictures.set(jid, url);
    // Update overview if exists
    const overview = this.chatsOverview.get(jid);
    if (overview) {
      overview.profilePicture = url;
    }
  }

  /**
   * Get cached profile picture
   */
  getProfilePicture(jid) {
    return this.profilePictures.get(jid) || null;
  }

  /**
   * FAST: Get chats overview (uses pre-computed cache)
   */
  getChatsOverviewFast(options = {}) {
    const { limit = 50, offset = 0 } = options;
    
    // Build overview if empty
    if (this.chatsOverview.size === 0) {
      this._rebuildOverviewCache();
    }
    
    // Use cached sorted array if available, otherwise sort and cache
    if (!this._sortedOverviewCache) {
      this._sortedOverviewCache = Array.from(this.chatsOverview.values());
      this._sortedOverviewCache.sort((a, b) => {
        const timeA = a.conversationTimestamp || a.lastMessage?.timestamp || 0;
        const timeB = b.conversationTimestamp || b.lastMessage?.timestamp || 0;
        return timeB - timeA;
      });
    }
    
    // Apply pagination directly on cached sorted array
    return {
      total: this._sortedOverviewCache.length,
      offset,
      limit,
      data: this._sortedOverviewCache.slice(offset, offset + limit)
    };
  }

  /**
   * Rebuild overview cache from scratch
   */
  _rebuildOverviewCache() {
    this.chatsOverview.clear();
    
    for (const [chatId, chatMessages] of this.messages) {
      if (chatMessages.size > 0) {
        this._updateSingleChatOverview(chatId);
      }
    }
  }

  /**
   * FAST: Get contacts (optimized)
   */
  getContactsFast(options = {}) {
    const { limit = 100, offset = 0, search = '' } = options;
    
    // Individual contacts: Baileys v7 keys them by @s.whatsapp.net; older data
    // and normalized ids use @c.us. Groups (@g.us) and unresolved @lid are not contacts.
    let contacts = Array.from(this.contacts.values())
      .filter(c => c.id && (c.id.endsWith('@c.us') || c.id.endsWith('@s.whatsapp.net')))
      .map(c => ({
        id: c.id,
        name: c.name || c.notify || c.id.split('@')[0],
        notify: c.notify,
        verifiedName: c.verifiedName,
        profilePicture: this.profilePictures.get(c.id) || null
      }));
    
    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      contacts = contacts.filter(c => 
        c.name?.toLowerCase().includes(searchLower) ||
        c.notify?.toLowerCase().includes(searchLower) ||
        c.id.includes(search)
      );
    }
    
    // Sort by name
    contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    return {
      total: contacts.length,
      offset,
      limit,
      data: contacts.slice(offset, offset + limit)
    };
  }

  /**
   * Get all chats
   */
  getAllChats() {
    return Array.from(this.chats.values());
  }

  /**
   * Get messages for a specific chat
   */
  getMessages(chatId, options = {}) {
    const { limit = 50, before = null } = options;
    const chatMessages = this.messages.get(chatId);
    
    if (!chatMessages) return [];
    
    let messages = Array.from(chatMessages.values())
      .filter(m => m && m.key && m.messageTimestamp); // Filter invalid messages
    
    messages.sort((a, b) => {
      const timeA = typeof a.messageTimestamp === 'object' ? (a.messageTimestamp.low || 0) : (a.messageTimestamp || 0);
      const timeB = typeof b.messageTimestamp === 'object' ? (b.messageTimestamp.low || 0) : (b.messageTimestamp || 0);
      return timeB - timeA;
    });
    
    if (before) {
      const beforeIndex = messages.findIndex(m => m.key?.id === before);
      if (beforeIndex > -1) {
        messages = messages.slice(beforeIndex + 1);
      }
    }
    
    return messages.slice(0, limit);
  }

  /**
   * Get a specific message by ID from a chat
   */
  getMessage(chatId, messageId) {
    const chatMessages = this.messages.get(chatId);
    if (!chatMessages) return null;
    return chatMessages.get(messageId) || null;
  }

  /**
   * Get a specific contact
   */
  getContact(jid) {
    return this.contacts.get(jid) || null;
  }

  /**
   * Get group metadata
   */
  getGroupMetadata(groupId) {
    return this.groupMetadata.get(groupId) || null;
  }

  /**
   * Get chat by ID
   */
  getChat(chatId) {
    return this.chats.get(chatId) || null;
  }

  /**
   * Safe JSON serialization (handles circular references and binary data)
   */
  _safeSerialize(data) {
    // Track the ancestor chain (not every object ever seen) so that legitimately
    // SHARED references — e.g. one lidMap mapping object stored under its lid, jid
    // and phone keys — are serialized in full instead of being nulled out. A plain
    // WeakSet of all seen objects wrongly treats a DAG as circular, which used to
    // corrupt lidMap entries into `null` and break LID→phone resolution on reload.
    const stack = [];

    return JSON.stringify(data, function (key, value) {
      // Skip binary data and buffers
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        return undefined;
      }
      if (Buffer.isBuffer && Buffer.isBuffer(value)) {
        return undefined;
      }

      // Skip functions
      if (typeof value === 'function') {
        return undefined;
      }

      if (typeof value === 'object' && value !== null) {
        // `this` is the holder currently being serialized. Pop ancestors we have
        // finished with, then only reject `value` if it is a true ancestor (cycle).
        while (stack.length > 0 && stack[stack.length - 1] !== this) {
          stack.pop();
        }
        if (stack.includes(value)) {
          return undefined; // real circular reference
        }
        stack.push(value);
      }

      return value;
    }, 2);
  }

  /**
   * Write store to file (for persistence) - FIXED JSON serialization
   */
  writeToFile(filePath) {
    const fs = require('fs');
    const path = require('path');
    
    try {
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Convert Maps to arrays for serialization
      const data = {
        chats: Array.from(this.chats.entries()),
        contacts: Array.from(this.contacts.entries()),
        messages: Array.from(this.messages.entries()).map(([chatId, msgs]) => [
          chatId,
          Array.from(msgs.entries()).slice(-100) // Keep only last 100 messages per chat
        ]),
        groupMetadata: Array.from(this.groupMetadata.entries()),
        profilePictures: Array.from(this.profilePictures.entries()),
        lidMap: Array.from(this.lidMap.entries()),
        labels: Array.from(this.labels.entries()),
        labelAssociations: Array.from(this.labelAssociations.entries()).map(([chatId, labelSet]) => [
          chatId,
          Array.from(labelSet)
        ])
      };
      
      // Use safe serialization to avoid .enc or corrupted files
      const jsonContent = this._safeSerialize(data);
      
      // Write to temp file first, then rename (atomic write)
      const tempPath = filePath + '.tmp';
      fs.writeFileSync(tempPath, jsonContent, 'utf8');
      
      // Rename temp to final (atomic on most filesystems)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tempPath, filePath);
      
      return true;
    } catch (error) {
      console.error('Error writing store to file:', error.message);
      return false;
    }
  }

  /**
   * Read store from file (for restoration)
   */
  readFromFile(filePath) {
    const fs = require('fs');
    
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      
      const content = fs.readFileSync(filePath, 'utf8');
      
      // Validate JSON before parsing
      if (!content || content.trim() === '') {
        console.warn('Store file is empty');
        return false;
      }
      
      // Check if file is corrupted (e.g., .enc issue)
      if (!content.startsWith('{')) {
        console.warn('Store file appears corrupted, skipping restore');
        // Delete corrupted file
        fs.unlinkSync(filePath);
        return false;
      }
      
      const data = JSON.parse(content);
      
      // Restore Maps
      if (data.chats) {
        this.chats = new Map(data.chats);
      }
      if (data.contacts) {
        this.contacts = new Map(data.contacts);
      }
      if (data.messages) {
        this.messages = new Map(
          data.messages.map(([chatId, msgs]) => [chatId, new Map(msgs)])
        );
      }
      if (data.groupMetadata) {
        this.groupMetadata = new Map(data.groupMetadata);
      }
      if (data.profilePictures) {
        this.profilePictures = new Map(data.profilePictures);
      }
      if (data.lidMap) {
        this.lidMap = new Map(data.lidMap);
      }
      if (data.labels) {
        this.labels = new Map(data.labels);
      }
      if (data.labelAssociations) {
        this.labelAssociations = new Map(
          data.labelAssociations.map(([chatId, labelIds]) => [chatId, new Set(labelIds)])
        );
      }
      
      // Reconstruct lidMap from contacts (collect first to avoid modifying map during iteration)
      const identityPairs = [];
      for (const [id, contact] of this.contacts.entries()) {
        if (contact.id && contact.lid && !contact.id.endsWith('@lid')) {
          identityPairs.push({ lid: contact.lid, jid: contact.id });
        }
        // Baileys v7 keys @lid contacts with the real phone JID in `phoneNumber`.
        // This is what lets @lid chats resolve to a number on restore.
        const pn = contact.phoneNumber;
        if (contact.id && contact.id.endsWith('@lid') && pn &&
            (pn.endsWith('@s.whatsapp.net') || pn.endsWith('@c.us'))) {
          identityPairs.push({ lid: contact.id, jid: pn });
        }
      }

      // Also reconstruct lidMap from remoteJidAlt in stored messages (Baileys v7)
      for (const [chatId, chatMsgs] of this.messages.entries()) {
        for (const [msgId, msg] of chatMsgs.entries()) {
          if (!msg || !msg.key) continue;
          const altJid = msg.key?.remoteJidAlt || msg.remoteJidAlt;
          if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@lid') && altJid && altJid.endsWith('@s.whatsapp.net')) {
            identityPairs.push({ lid: msg.key.remoteJid, jid: altJid });
          }
          // Extract pushName into contacts. Prefer the resolved PN JID (altJid),
          // but for chats that are still keyed by @lid store it under the LID so
          // the chat list shows a name instead of the raw LID digits.
          if (msg.pushName && !msg.key.fromMe) {
            const contactKey =
              (altJid && altJid.endsWith('@s.whatsapp.net')) ? altJid :
              (msg.key.remoteJid && !msg.key.remoteJid.endsWith('@g.us')) ? msg.key.remoteJid :
              null;
            if (contactKey) {
              const existing = this.contacts.get(contactKey) || {};
              if (!existing.notify && !existing.name) {
                this.contacts.set(contactKey, { ...existing, id: contactKey, notify: msg.pushName });
              }
            }
          }
        }
      }

      for (const { lid, jid } of identityPairs) {
        this.registerIdentity(lid, jid);
      }

      // Resolve any remaining LID keys using restored lidMap
      this._resolveAllLidKeys();

      // Rebuild overview cache after restore (uses clean JID keys)
      this._rebuildOverviewCache();
      
      return true;
    } catch (error) {
      console.error('Error reading store from file:', error.message);
      return false;
    }
  }

  /**
   * Clear all data
   */
  clear() {
    // Clean up all media files first
    this._cleanupAllMedia();
    
    this.chats.clear();
    this.contacts.clear();
    this.messages.clear();
    this.groupMetadata.clear();
    this.chatsOverview.clear();
    this.profilePictures.clear();
    this.contactsCache.clear();
    this.mediaFiles.clear();
    this.labels.clear();
    this.labelAssociations.clear();
  }

  /**
   * Get store statistics
   */
  getStats() {
    let totalMessages = 0;
    for (const [, chatMessages] of this.messages) {
      totalMessages += chatMessages.size;
    }
    
    return {
      chats: this.chats.size,
      contacts: this.contacts.size,
      messages: totalMessages,
      groups: this.groupMetadata.size,
      mediaFiles: this.mediaFiles.size,
      labels: this.labels.size
    };
  }

  // ==================== LABEL METHODS ====================

  /**
   * Get all labels
   */
  getLabels() {
    return Array.from(this.labels.values());
  }

  /**
   * Get label by ID
   */
  getLabelById(labelId) {
    return this.labels.get(labelId) || null;
  }

  /**
   * Get all labels for a specific chat
   */
  getLabelsByChat(chatId) {
    const labelIds = this.labelAssociations.get(chatId);
    if (!labelIds || labelIds.size === 0) return [];
    return Array.from(labelIds)
      .map(id => this.labels.get(id))
      .filter(Boolean);
  }

  /**
   * Get all chats that have a specific label
   */
  getChatsByLabel(labelId) {
    const result = [];
    for (const [chatId, labelSet] of this.labelAssociations.entries()) {
      if (labelSet.has(labelId)) {
        const overview = this.chatsOverview.get(chatId);
        result.push({
          chatId,
          name: overview?.name || chatId.split('@')[0],
          isGroup: chatId.endsWith('@g.us'),
          profilePicture: overview?.profilePicture || null
        });
      }
    }
    return result;
  }

  /**
   * Manually add a label association (used when Baileys method is called)
   */
  addLabelAssociation(chatId, labelId) {
    if (!this.labelAssociations.has(chatId)) {
      this.labelAssociations.set(chatId, new Set());
    }
    this.labelAssociations.get(chatId).add(labelId);
  }

  /**
   * Manually remove a label association
   */
  removeLabelAssociation(chatId, labelId) {
    const labelSet = this.labelAssociations.get(chatId);
    if (labelSet) {
      labelSet.delete(labelId);
      if (labelSet.size === 0) this.labelAssociations.delete(chatId);
    }
  }

  /**
   * Register a media file for a message
   */
  registerMediaFile(messageId, filePath) {
    this.mediaFiles.set(messageId, filePath);
  }

  /**
   * Delete media file for a message
   */
  _deleteMediaFile(messageId) {
    const fs = require('fs');
    const filePath = this.mediaFiles.get(messageId);
    if (filePath) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ [${this.sessionId}] Media deleted: ${filePath}`);
        }
      } catch (e) {
        // Silent fail
      }
      this.mediaFiles.delete(messageId);
    }
  }

  /**
   * Cleanup all media files
   */
  _cleanupAllMedia() {
    const fs = require('fs');
    for (const [messageId, filePath] of this.mediaFiles) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        // Silent fail
      }
    }
    this.mediaFiles.clear();
  }

  /**
   * Cleanup old media files (keep only last N messages per chat)
   */
  cleanupOldMedia(maxMessagesPerChat = 100) {
    const fs = require('fs');
    const messagesToKeep = new Set();
    
    // Collect message IDs that should be kept
    for (const [chatId, chatMessages] of this.messages) {
      const msgs = Array.from(chatMessages.values())
        .filter(m => m && m.messageTimestamp)
        .sort((a, b) => {
          const timeA = typeof a.messageTimestamp === 'object' ? (a.messageTimestamp.low || 0) : (a.messageTimestamp || 0);
          const timeB = typeof b.messageTimestamp === 'object' ? (b.messageTimestamp.low || 0) : (b.messageTimestamp || 0);
          return timeB - timeA;
        })
        .slice(0, maxMessagesPerChat);
      
      for (const msg of msgs) {
        if (msg.key?.id) {
          messagesToKeep.add(msg.key.id);
        }
      }
    }
    
    // Delete media files for messages that will be removed
    for (const [messageId, filePath] of this.mediaFiles) {
      if (!messagesToKeep.has(messageId)) {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ [${this.sessionId}] Old media cleaned: ${filePath}`);
          }
        } catch (e) {
          // Silent fail
        }
        this.mediaFiles.delete(messageId);
      }
    }
  }

  /**
   * Migrate any existing data (chats, messages, contacts) from LID to PN JID
   */
  _migrateLidData(lid, jid) {
    const normalizedLid = lid.toLowerCase();
    const normalizedJid = jid.toLowerCase();
    
    // 1. Migrate chats
    if (this.chats.has(normalizedLid)) {
      const chat = this.chats.get(normalizedLid);
      this.chats.delete(normalizedLid);
      chat.id = normalizedJid;
      // Merge with existing chat if already exists
      const existingChat = this.chats.get(normalizedJid) || {};
      this.chats.set(normalizedJid, { ...existingChat, ...chat });
    }
    
    // 2. Migrate contacts
    if (this.contacts.has(normalizedLid)) {
      const contact = this.contacts.get(normalizedLid);
      this.contacts.delete(normalizedLid);
      contact.id = normalizedJid;
      // Merge with existing contact if already exists
      const existingContact = this.contacts.get(normalizedJid) || {};
      this.contacts.set(normalizedJid, { ...existingContact, ...contact });
    }
    
    // 3. Migrate messages
    if (this.messages.has(normalizedLid)) {
      const lidMsgs = this.messages.get(normalizedLid);
      this.messages.delete(normalizedLid);
      
      // Get or create messages Map for the normalized PN JID
      if (!this.messages.has(normalizedJid)) {
        this.messages.set(normalizedJid, new Map());
      }
      const jidMsgs = this.messages.get(normalizedJid);
      
      for (const [msgId, msg] of lidMsgs.entries()) {
        if (msg && msg.key) {
          msg.key.remoteJid = normalizedJid;
          if (msg.key.participant === normalizedLid) {
            msg.key.participant = normalizedJid;
          }
        }
        jidMsgs.set(msgId, msg);
      }
    }
    
    // 4. Migrate chatsOverview and recompute the display name from the resolved contact
    if (this.chatsOverview.has(normalizedLid)) {
      const overview = this.chatsOverview.get(normalizedLid);
      this.chatsOverview.delete(normalizedLid);
      overview.id = normalizedJid;
      const contact = this.contacts.get(normalizedJid);
      const phone = normalizedJid.split('@')[0];
      overview.name = contact?.name || contact?.notify || phone;
      this.chatsOverview.set(normalizedJid, overview);
    }

    // 5. Migrate profile pictures so the resolved JID shows the cached avatar
    if (this.profilePictures.has(normalizedLid)) {
      const pic = this.profilePictures.get(normalizedLid);
      this.profilePictures.delete(normalizedLid);
      this.profilePictures.set(normalizedJid, pic);
    }

    // 6. Invalidate sorted caches so the next read uses the migrated data
    this._invalidateOverviewCache();
    this._invalidateContactsCache();
  }

  /**
   * Scan all data maps and resolve any remaining LID keys to JID using lidMap.
   * Called after readFromFile to clean up persisted LID keys.
   */
  _resolveAllLidKeys() {
    // Repair legacy stores where the serializer nulled out the shared jid/phone
    // keys of lidMap (see _safeSerialize). Rebuild them from the intact @lid
    // entries so reverse lookups (jid/phone → identity) work again.
    for (const [key, mapping] of Array.from(this.lidMap.entries())) {
      if (key.endsWith('@lid') && mapping && mapping.jid) {
        if (mapping.jid && !this.lidMap.get(mapping.jid)) this.lidMap.set(mapping.jid, mapping);
        if (mapping.pn && !this.lidMap.get(mapping.pn)) this.lidMap.set(mapping.pn, mapping);
      }
    }

    // Drop any remaining null/invalid entries so later iterations never crash.
    for (const [key, mapping] of Array.from(this.lidMap.entries())) {
      if (!mapping || typeof mapping !== 'object') this.lidMap.delete(key);
    }

    // Collect all known LID→JID mappings from lidMap
    const migrations = new Map();
    for (const [key, mapping] of this.lidMap.entries()) {
      // Guard against null entries from older corrupted stores.
      if (key.endsWith('@lid') && mapping && mapping.jid && !mapping.jid.endsWith('@lid')) {
        migrations.set(key, mapping.jid);
      }
    }

    // Run migration for each LID that has a known JID
    for (const [lid, jid] of migrations.entries()) {
      this._migrateLidData(lid, jid);
    }
  }

  /**
   * Register a mapping between LID, JID (PN JID), and PN (Phone Number)
   */
  registerIdentity(lid, jid, pn = null) {
    if (!lid || !jid) return;
    
    const normalizedLid = lid.toLowerCase();
    const normalizedJid = jid.toLowerCase();
    const cleanPn = pn || normalizedJid.split('@')[0];
    
    const mapping = {
      lid: normalizedLid,
      pn: cleanPn,
      jid: normalizedJid
    };
    
    // Register by LID, JID, and PN for fast O(1) lookups
    this.lidMap.set(normalizedLid, mapping);
    this.lidMap.set(normalizedJid, mapping);
    this.lidMap.set(cleanPn, mapping);

    // Dynamic migration of stored data from LID to PN JID!
    try {
      this._migrateLidData(normalizedLid, normalizedJid);
    } catch (e) {
      console.error(`Error migrating LID data for ${normalizedLid}:`, e.message);
    }
  }

  /**
   * Resolve any identifier (LID, JID, or Phone Number) to its complete identity mapping
   */
  resolveIdentity(identifier) {
    if (!identifier) return null;
    const cleanId = identifier.toString().toLowerCase();
    
    // 1. Check primary lidMap cache
    if (this.lidMap.has(cleanId)) {
      return this.lidMap.get(cleanId);
    }
    
    // 2. Fallback: Search in contacts list
    for (const [id, contact] of this.contacts.entries()) {
      if (contact.id && contact.lid) {
        const lidLower = contact.lid.toLowerCase();
        const idLower = contact.id.toLowerCase();
        if (lidLower === cleanId || idLower === cleanId || idLower.split('@')[0] === cleanId) {
          this.registerIdentity(contact.lid, contact.id);
          return this.lidMap.get(cleanId);
        }
      }
    }
    return null;
  }

  /**
   * Resolve any JID (LID or PN JID) to a phone number.
   * If not found in the mapping registry, it falls back to parsing the JID if it is a PN JID,
   * or returns the input itself.
   */
  resolvePhoneNumber(jid) {
    if (!jid) return null;
    const resolved = this.resolveIdentity(jid);
    if (resolved && resolved.pn) {
      return resolved.pn;
    }
    // Fallback: if it's a phone-number JID, split to get the phone number.
    // Baileys keys personal chats by @s.whatsapp.net (v7) or @c.us (normalized/legacy).
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) {
      return jid.split('@')[0];
    }
    // For any other JID (group @g.us or unresolved @lid) never expose the raw
    // domain suffix in the UI — return just the local part.
    return jid.includes('@') ? jid.split('@')[0] : jid;
  }
}

BaileysStore.toUnixSeconds = toUnixSeconds;
module.exports = BaileysStore;
