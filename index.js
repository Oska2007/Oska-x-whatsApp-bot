import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import config from './config.js';
import { formatBytes, getMaxAllowedDownloadSize } from './lib/utils.js';
import { handleCommand } from './handlers/commandHandler.js';
import { promptSetup } from './lib/startup.js';

// ============================================================
// Global Error Handlers
// ============================================================
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

// ============================================================
// ✅ FIX #2: Cleanup temp folder on startup
// ============================================================
const TEMP_DIR = './temp';
if (fs.existsSync(TEMP_DIR)) {
    let cleaned = 0;
    try {
        for (const file of fs.readdirSync(TEMP_DIR)) {
            try {
                fs.unlinkSync(path.join(TEMP_DIR, file));
                cleaned++;
            } catch (e) {}
        }
        if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} old temp file(s) on startup`);
    } catch (e) {
        console.error('⚠️ Temp cleanup failed:', e.message);
    }
}

// ============================================================
// Helpers
// ============================================================
const normalizeNumber = (s) => (s || '').replace(/[^0-9]/g, '');
const jidToDigits = (s) => (s || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

// Runtime settings (populated by startup prompt + after connect)
let runtime = {
    usePairingCode: false,
    pairingNumber: null,
    allowedUsers: [],
    ownerNumber: null
};

// LID → PN cache
const lidToPnCache = new Map();

// ============================================================
// ✅ FIX #1: Socket lifecycle management (prevent leaks)
// ============================================================
let currentSock = null;
let reconnectTimer = null;
let isConnecting = false;

// ============================================================
// ✅ FIX #3: Message dedup (prevent duplicate replies)
// ============================================================
const processedMsgIds = new Set();
const MSG_ID_TTL = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup for dedup set
setInterval(() => {
    if (processedMsgIds.size > 500) {
        processedMsgIds.clear();
    }
}, MSG_ID_TTL);

async function resolvePN(sock, lidJid) {
    if (!lidJid || !lidJid.endsWith('@lid')) return null;
    const lidDigits = jidToDigits(lidJid);
    if (lidToPnCache.has(lidDigits)) return lidToPnCache.get(lidDigits);

    try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
        if (pn) {
            const digits = jidToDigits(pn);
            if (digits) {
                lidToPnCache.set(lidDigits, digits);
                return digits;
            }
        }
    } catch (e) {}

    return null;
}

async function connectToWhatsApp() {
    // ✅ Guard: already connecting → skip duplicate invocation
    if (isConnecting) {
        console.log('[!] Already connecting, skipping duplicate call');
        return;
    }
    isConnecting = true;

    try {
        // ✅ FIX #1: Clean up previous socket BEFORE creating a new one
        if (currentSock) {
            try {
                currentSock.ev.removeAllListeners();
                currentSock.ws?.close();
                currentSock.end?.(undefined);
            } catch (e) {}
            currentSock = null;
        }

        // ✅ FIX #1: Clear any pending reconnect timer
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        const { state, saveCreds } = await useMultiFileAuthState('./session');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            markOnlineOnConnect: false,
            // ✅ FIX #1: syncFullHistory=false prevents RAM explosion on large accounts
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        // ✅ FIX #1: Track active socket globally
        currentSock = sock;

        sock.ev.on('creds.update', saveCreds);

        // Contacts cache (for LID → PN resolution)
        const cacheContact = (c) => {
            if (!c) return;
            if (c.id && c.lid) lidToPnCache.set(jidToDigits(c.lid), jidToDigits(c.id));
            if (c.id?.endsWith('@lid') && c.phoneNumber) {
                lidToPnCache.set(jidToDigits(c.id), jidToDigits(c.phoneNumber));
            }
        };
        sock.ev.on('contacts.upsert', (contacts) => contacts?.forEach(cacheContact));
        sock.ev.on('contacts.update', (updates) => updates?.forEach(cacheContact));
        sock.ev.on('messaging-history.set', ({ contacts }) => contacts?.forEach(cacheContact));

        // Pairing Code
        if (runtime.usePairingCode && !sock.authState.creds.registered) {
            const phoneNumber = normalizeNumber(runtime.pairingNumber);
            if (phoneNumber) {
                setTimeout(async () => {
                    try {
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log('--------------------------------------------------');
                        console.log(`🔑 Your WhatsApp Pairing Code: ${code}`);
                        console.log('--------------------------------------------------');
                    } catch (error) {
                        console.error('Failed to request pairing code:', error);
                    }
                }, 3000);
            }
        }

        // Connection
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR Code
            if (qr && !runtime.usePairingCode) {
                console.log('\n📌 Scan the QR Code below:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[!] Connection lost (${statusCode}). Reconnecting in 5s...`);

                // ✅ FIX #1: Reset flag, schedule reconnect safely
                isConnecting = false;

                if (shouldReconnect) {
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        connectToWhatsApp();
                    }, 5000);
                } else {
                    console.log('[X] Logged out. Delete "session" folder and re-pair.');
                }
            } else if (connection === 'open') {
                // ✅ FIX #1: Connection succeeded — reset flag
                isConnecting = false;

                await sock.sendPresenceUpdate('unavailable');

                // Resolve owner number from connected session
                const ownerJid = sock.user?.id || '';
                runtime.ownerNumber = jidToDigits(ownerJid);

                const ram = getMaxAllowedDownloadSize();
                const line = '═'.repeat(55);

                console.log(`\n\x1b[32m${line}\x1b[0m`);
                console.log(`\x1b[1m\x1b[32m  ✅ ${config.botName || 'Bot'} — CONNECTED\x1b[0m`);
                console.log(`\x1b[32m${line}\x1b[0m`);
                console.log(`  🧠  Free RAM       : \x1b[36m${formatBytes(ram.freeRamBytes)}\x1b[0m`);
                console.log(`  📥  Max Download   : \x1b[36m${formatBytes(ram.maxDownloadBytes)}\x1b[0m`);
                console.log(`\x1b[32m${line}\x1b[0m`);
                console.log(`  📌  Prefix         : \x1b[33m${config.prefix}\x1b[0m`);
                console.log(`  🔑  Method         : \x1b[33m${runtime.usePairingCode ? 'Pairing Code' : 'QR Code'}\x1b[0m`);
                console.log(`  👤  Owner Number   : \x1b[33m${runtime.ownerNumber || '(unknown)'}\x1b[0m`);

                if (runtime.allowedUsers.length === 0) {
                    console.log(`  👥  Access         : \x1b[33mOwner only 🔒\x1b[0m`);
                } else {
                    console.log(`  👥  Allowed Users  : \x1b[33m${runtime.allowedUsers.length} + owner\x1b[0m`);
                    runtime.allowedUsers.forEach((u, i) => {
                        console.log(`        ${i + 1}. ${u}`);
                    });
                }
                console.log(`\x1b[32m${line}\x1b[0m\n`);
            }
        });

        // Messages
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            await sock.sendPresenceUpdate('unavailable');

            const msg = messages[0];
            if (!msg || !msg.message) return;

            const from = msg.key.remoteJid;
            if (from === 'status@broadcast') return;

            // ✅ FIX #3: Message dedup — skip already-processed message IDs
            const msgId = msg.key?.id;
            if (msgId) {
                if (processedMsgIds.has(msgId)) {
                    return;
                }
                processedMsgIds.add(msgId);
            }

            try {
                // Sender identities
                const senderJid = msg.key.participant || msg.key.remoteJid;
                const candidates = new Set();

                const sDigits = jidToDigits(senderJid);
                if (sDigits) candidates.add(sDigits);

                const altJid = msg.key.participantAlt || msg.key.senderPn;
                if (altJid) {
                    const altDigits = jidToDigits(altJid);
                    if (altDigits) candidates.add(altDigits);
                }

                if (senderJid?.endsWith('@lid')) {
                    const resolved = await resolvePN(sock, senderJid);
                    if (resolved) candidates.add(resolved);
                }

                const candidateArr = [...candidates];

                // ============================================================
                // AUTHORIZATION — owner always allowed
                // allowedUsers empty → owner only
                // allowedUsers has numbers → owner + those numbers
                // ============================================================
                const isOwner = runtime.ownerNumber && candidateArr.includes(runtime.ownerNumber);

                let isAllowed = msg.key.fromMe || isOwner;

                if (!isAllowed && runtime.allowedUsers.length > 0) {
                    isAllowed = runtime.allowedUsers.some((entry) => {
                        const clean = normalizeNumber(entry);
                        return clean && candidateArr.includes(clean);
                    });
                }
                // ============================================================

                if (!isAllowed) return;

                const textMessage = msg.message.conversation ||
                                    msg.message.extendedTextMessage?.text ||
                                    msg.message.imageMessage?.caption ||
                                    msg.message.videoMessage?.caption || '';

                if (!textMessage.startsWith(config.prefix)) return;

                await handleCommand(sock, msg, from, textMessage);

            } catch (cmdError) {
                console.error(`❌ Command error:`, cmdError);
                try {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(from, {
                        text: `⚠️ *Error!*\n\n🚨 ${cmdError.message || cmdError}`
                    }, { quoted: msg });
                } catch (e) {}
            }
        });

    } catch (err) {
        console.error('❌ Fatal error:', err);
        // ✅ FIX #1: Reset flag on fatal error so we can retry
        isConnecting = false;
    }
}

// ============================================================
// Main entry — session එක තියෙනවා නම් prompt skip කරන්න
// ============================================================
const SETTINGS_FILE = './session/settings.json';

(async () => {
    if (fs.existsSync('./session/creds.json')) {
        // ✅ Session තියෙනවා — prompt skip, saved settings load කරන්න
        let saved = {};
        try {
            if (fs.existsSync(SETTINGS_FILE)) {
                saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('⚠️ Could not read settings.json:', e.message);
        }

        console.log('✅ Existing session found — loading saved settings');
        runtime = {
            usePairingCode: false,
            pairingNumber: null,
            allowedUsers: Array.isArray(saved.allowedUsers) ? saved.allowedUsers : []
        };
    } else {
        // පළමු වතාවට — terminal prompt එකේ විදිහටම
        runtime = await promptSetup();

        // ✅ Prompt එකෙන් ආපු settings save කරන්න
        try {
            fs.mkdirSync('./session', { recursive: true });
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
                allowedUsers: runtime.allowedUsers || []
            }, null, 2));
            console.log(`💾 Saved settings → ${SETTINGS_FILE}`);
        } catch (e) {
            console.error('⚠️ Could not save settings.json:', e.message);
        }
    }

    await connectToWhatsApp();
})();
