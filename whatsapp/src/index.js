'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');

const app = express();
app.use(express.json());

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_CALLBACK_URL = process.env.BOT_CALLBACK_URL || 'http://kifaa-bot:8001/webhook/whatsapp';
const BRIDGE_SECRET = process.env.WHATSAPP_BRIDGE_SECRET || '';
const ADMIN_TOKEN = process.env.WA_ADMIN_TOKEN || '';
const SESSION_DIR = process.env.SESSION_DIR || '/data/session';

// ── State ────────────────────────────────────────────────────────────────────
let currentQR = null;        // base64 PNG QR code
let clientStatus = 'starting'; // starting | qr_pending | ready | disconnected

// ── WhatsApp client ──────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
        ],
        headless: true,
    },
});

client.on('qr', async (qr) => {
    clientStatus = 'qr_pending';
    currentQR = await qrcode.toDataURL(qr);
    console.log('[WhatsApp] QR code generated — scan via Kifaa UI');
});

client.on('authenticated', () => {
    console.log('[WhatsApp] Authenticated');
    currentQR = null;
});

client.on('ready', () => {
    clientStatus = 'ready';
    currentQR = null;
    console.log('[WhatsApp] Client ready');
});

client.on('disconnected', (reason) => {
    clientStatus = 'disconnected';
    console.log('[WhatsApp] Disconnected:', reason);
});

client.on('message', async (msg) => {
    // Ignore group messages, status updates, and bot's own messages
    if (msg.from === 'status@broadcast') return;
    if (msg.fromMe) return;
    if (msg.from.endsWith('@g.us')) return; // group chat

    const payload = {
        from: msg.from,
        body: msg.body,
        id: msg.id._serialized,
        timestamp: msg.timestamp,
    };

    try {
        const resp = await fetch(BOT_CALLBACK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${BRIDGE_SECRET}`,
            },
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            console.error('[WhatsApp] Bot callback error:', resp.status, await resp.text());
        }
    } catch (err) {
        console.error('[WhatsApp] Bot callback failed:', err.message);
    }
});

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireToken(req, res, next) {
    if (!ADMIN_TOKEN) return next(); // token not configured — allow (dev mode)
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function requireBridgeSecret(req, res, next) {
    if (!BRIDGE_SECRET) return next();
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== BRIDGE_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ── REST API ─────────────────────────────────────────────────────────────────

// GET /status — health + connection status
app.get('/status', requireToken, (req, res) => {
    res.json({ status: clientStatus, qr_needed: clientStatus === 'qr_pending' });
});

// GET /qr — return QR data URL for admin to scan
app.get('/qr', requireToken, (req, res) => {
    if (clientStatus === 'ready') {
        return res.json({ status: 'ready' });
    }
    if (clientStatus === 'qr_pending' && currentQR) {
        return res.json({ status: 'qr_pending', qr_data_url: currentQR });
    }
    res.json({ status: clientStatus });
});

// POST /send — send a message (called by kifaa-bot)
app.post('/send', requireBridgeSecret, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ error: 'to and message are required' });
    }
    if (clientStatus !== 'ready') {
        return res.status(503).json({ error: `WhatsApp client not ready (status: ${clientStatus})` });
    }
    const chatId = to.endsWith('@c.us') ? to : `${to}@c.us`;
    try {
        await client.sendMessage(chatId, message);
        res.json({ status: 'sent' });
    } catch (err) {
        console.error('[WhatsApp] Send error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /logout — disconnect and clear session
app.post('/logout', requireToken, async (req, res) => {
    try {
        await client.logout();
        clientStatus = 'disconnected';
        res.json({ status: 'logged_out' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[WhatsApp Bridge] Listening on port ${PORT}`);
});

client.initialize().catch(err => {
    console.error('[WhatsApp] Initialization failed:', err);
    clientStatus = 'disconnected';
});
