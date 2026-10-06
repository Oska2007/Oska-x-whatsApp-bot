import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import config from './config.js';
import { formatBytes, getMaxAllowedDownloadSize } from './lib/utils.js';
import { handleCommand } from './handlers/commandHandler.js';

// Global Error Handlers (Prevents Bot from Crashing)
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

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
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        // Pairing Code
        if (config.usePairingCode && !sock.authState.creds.registered) {
            const phoneNumber = config.owner.replace(/[^0-9]/g, '');
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
            } else {
                console.log('⚠️ Please set a valid phone number in config.js to obtain a pairing code.');
            }
        }

        // Connection Status
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !config.usePairingCode) {
                console.log('\n📌 Scan the QR Code below:\n');
                qrcode.generate(qr, { small: true });
            }
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[!] Connection lost (${statusCode}). Reconnecting in 5 seconds...`);
                if (shouldReconnect) {
                    setTimeout(() => connectToWhatsApp(), 5000);
                } else {
                    console.log('[X] Session logged out. Delete "session" folder and re-scan QR code or re-pair code.');
                }
            } else if (connection === 'open') {
                await sock.sendPresenceUpdate('unavailable');

                const initialRam = getMaxAllowedDownloadSize();
                console.log('--------------------------------------------------');
                console.log(`✅ ${config.botName || 'Bot'} successfully connected to WhatsApp!`);
                console.log(`🧠 Free RAM: ${formatBytes(initialRam.freeRamBytes)} \vert{} Dynamic Max Download Limit:${formatBytes(initialRam.maxDownloadBytes)}`);
                console.log('--------------------------------------------------');
            }
        });

        // Message Handler
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            const msg = messages[0];
            if (!msg || !msg.message) return;

            const from = msg.key.remoteJid;
            
            try {
                const sender = msg.key.participant || msg.key.remoteJid;
                const senderNumber = sender.replace(/[^0-9]/g, '');

                // FIX: Strict equality check to prevent authorization bypass
                const isAllowed = msg.key.fromMe || config.allowedUsers.some(num => senderNumber === num.replace(/[^0-9]/g, ''));
                if (!isAllowed) return;

                const textMessage = msg.message.conversation ||
                                    msg.message.extendedTextMessage?.text ||
                                    msg.message.imageMessage?.caption ||
                                    msg.message.videoMessage?.caption || '';

                if (!textMessage.startsWith(config.prefix)) return;

                // Call Command Handler
                await handleCommand(sock, msg, from, textMessage);

            } catch (cmdError) {
                console.error(`❌ Error in command execution:`, cmdError);
                try {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(from, { 
                        text: `⚠️ *An unexpected error occurred!*\n\n🚨 *Details:* ${cmdError.message || cmdError}` 
                    }, { quoted: msg });
                } catch (e) {
                    console.error('Failed to send error notification message:', e);
                }
            }
        });

    } catch (err) {
        console.error('❌ Fatal error connecting to WhatsApp:', err);
    }
}

// Start the Bot
connectToWhatsApp();
