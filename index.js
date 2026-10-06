import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import config from './config.js';
import { formatBytes, getMaxAllowedDownloadSize } from './lib/utils.js';
import { handleCommand } from './handlers/commandHandler.js';
import { promptSetup } from './lib/startup.js';
import { registerRestartHandler } from './lib/restart.js';
import { downloadQueue } from './lib/downloader.js';

// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message || err);
});
process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Rejection:', reason);
});

// Helpers
const normalizeNumber = (s) => (s || '').replace(/[^0-9]/g, '');
const jidToDigits = (s) => (s || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

// Runtime settings
let runtime = {
    usePairingCode: false,
    pairingNumber: null,
    allowedUsers: [],
    ownerNumber: null
};

// LID → PN cache
const lidToPnCache = new Map();

// Track current socket + restart lock
let currentSock = null;
let restarting = false;

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
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./session');
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            markOnlineOnConnect: false,
            syncFullHistory: true
        });

        currentSock = sock;

        sock.ev.on('creds.update', saveCreds);

        // ============================================================
        // 🔄 Restart handler
        // ============================================================
        registerRestartHandler(async () => {
            if (restarting) return { ok: false, reason: 'Restart already in progress' };
            restarting = true;

            const line = '─'.repeat(55);
            console.log(`\n\x1b[33m${line}\x1b[0m`);
            console.log(`\x1b[1m🔄 Restart requested\x1b[0m`);
            console.log(`\x1b[33m${line}\x1b[0m`);

            try {
                // 1. Abort + clear download queue
                downloadQueue.forEach(t => {
                    if (t.abortController) {
                        try { t.abortController.abort(); } catch (e) {}
                    }
                });
                downloadQueue.length = 0;
                console.log('  🗑️  Download queue cleared');

                // 2. Clear temp folder (keep session untouched)
                try {
                    if (fs.existsSync('./temp')) {
                        fs.rmSync('./temp', { recursive: true, force: true });
                    }
                    fs.mkdirSync('./temp', { recursive: true });
                    console.log('  🗑️  Temp folder cleared');
                } catch (e) {
                    console.error('  ⚠️  Temp cleanup failed:', e.message);
                }

                // 3. Close current socket (does NOT delete session)
                if (currentSock) {
                    try {
                        await currentSock.end(undefined);
                    } catch (e) {}
                    currentSock = null;
                }

                // 4. Wait for clean close
                await new Promise(r => setTimeout(r, 1500));

                // 5. Reconnect — session is intact, no re-pair needed
                console.log('  🔌 Reconnecting...');
                connectToWhatsApp();

                console.log(`\x1b[32m  ✅ Restart triggered\x1b[0m`);
                console.log(`\x1b[33m${line}\x1b[0m\n`);

                return { ok: true };
            } catch (err) {
                console.error('❌ Restart failed:', err.message);
                return { ok: false, reason: err.message };
            } finally {
                setTimeout(() => { restarting = false; }, 5000);
            }
        });
        // ============================================================

        // Contacts cache
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

            if (qr && !runtime.usePairingCode) {
                console.log('\n📌 Scan the QR Code below:\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[!] Connection lost (${statusCode}). Reconnecting in 5s...`);
                if (shouldReconnect) {
                    setTimeout(() => connectToWhatsApp(), 5000);
                } else {
                    console.log('[X] Logged out. Delete "session" folder and re-pair.');
                }
            } else if (connection === 'open') {
                await sock.sendPresenceUpdate('unavailable');

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

            try {
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

                // Authorization
                const isOwner = runtime.ownerNumber && candidateArr.includes(runtime.ownerNumber);

                let isAllowed = msg.key.fromMe || isOwner;

                if (!isAllowed && runtime.allowedUsers.length > 0) {
                    isAllowed = runtime.allowedUsers.some((entry) => {
                        const clean = normalizeNumber(entry);
                        return clean && candidateArr.includes(clean);
                    });
                }

                if (!isAllowed) return;

                const textMessage = msg.message.conversation ||
                                    msg.message.extendedTextMessage?.text ||
                                    msg.message.imageMessage?.caption ||
                                    msg.message.videoMessage?.caption || '';

                if (!textMessage.startsWith(config.prefix)) return;

                // 👇 Attach flags for command handler
                msg._isOwner = isOwner;

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
    }
}

// Main entry
(async () => {
    runtime = await promptSetup();
    await connectToWhatsApp();
})();