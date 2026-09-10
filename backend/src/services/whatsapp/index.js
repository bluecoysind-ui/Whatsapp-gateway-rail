/**
 * WhatsApp Service Module
 * 
 * Struktur file:
 * - BaileysStore.js     : Custom in-memory store untuk Baileys v7
 * - MessageFormatter.js : Utility untuk format pesan
 * - WhatsAppSession.js  : Class untuk mengelola satu sesi WhatsApp
 * - WhatsAppManager.js  : Singleton untuk mengelola semua sesi
 * - index.js            : Entry point (file ini)
 */

const WhatsAppManager = require('./WhatsAppManager');

// Singleton instance
const whatsappManager = new WhatsAppManager();

module.exports = whatsappManager;
