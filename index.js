import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    generateWAMessageFromContent
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import axios from 'axios';
import mime from 'mime-types';
import { fileTypeFromBuffer } from 'file-type';
import os from 'os';
import config from './config.js';

// Global Download Queue & Controller
const downloadQueue = [];
let isProcessingQueue = false;
let activeAbortController = null;

// Helper: Format Bytes to Human Readable Size
function formatBytes(bytes, decimals = 2) {
    if (!bytes || isNaN(bytes) || bytes === 0) return 'Unknown Size';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Baileys Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    // Connection Status
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📌 Scan the QR Code below:\n');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[!] Connection lost (${statusCode}). Reconnecting...`);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('[X] Session logged out. Delete "session" folder and re-scan QR code.');
            }
        } else if (connection === 'open') {
            console.log('--------------------------------------------------');
            console.log(`✅ ${config.botName || 'Bot'} successfully connected to WhatsApp!`);
            console.log('--------------------------------------------------');
        }
    });

    // Queue Processor
    async function processQueue() {
        if (isProcessingQueue) return;
        isProcessingQueue = true;

        while (downloadQueue.length > 0) {
            const task = downloadQueue[0];
            task.status = 'processing';
            activeAbortController = new AbortController();

            try {
                await sock.sendMessage(task.from, { react: { text: '⏳', key: task.msg.key } });

                const response = await axios.get(task.url, { 
                    responseType: 'arraybuffer',
                    signal: activeAbortController.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                const buffer = Buffer.from(response.data);
                const detectedType = await fileTypeFromBuffer(buffer);
                let mimeType = detectedType?.mime || response.headers['content-type']?.split(';')[0] || 'application/octet-stream';
                let ext = detectedType?.ext || mime.extension(mimeType) || '';

                let fileName = task.fileName || 'downloaded_file';
                const disposition = response.headers['content-disposition'];

                if (disposition && disposition.includes('filename=')) {
                    fileName = disposition.split('filename=')[1].replace(/["']/g, '').trim();
                }

                if (!fileName.includes('.') || fileName.endsWith('.bin')) {
                    const baseName = fileName.replace(/\.bin$/, '');
                    fileName = ext ? `${baseName}.${ext}` : baseName;
                }

                task.fileName = fileName;

                await sock.sendMessage(task.from, {
                    document: buffer,
                    mimetype: mimeType,
                    fileName: fileName
                }, { quoted: task.msg });

                await sock.sendMessage(task.from, { react: { text: '✅', key: task.msg.key } });

            } catch (error) {
                if (axios.isCancel(error) || error.name === 'CanceledError' || error.name === 'AbortError') {
                    console.log(`[Canceled] ${task.url}`);
                    await sock.sendMessage(task.from, { react: { text: '🛑', key: task.msg.key } });
                } else {
                    console.error(`DLURL Error (${task.url}):`, error.message);
                    await sock.sendMessage(task.from, { react: { text: '❌', key: task.msg.key } });
                    await sock.sendMessage(task.from, { 
                        text: `❌ *Download Error!*\n\n🔗 *Link:* ${task.url}\n⚠️ *Reason:* ${error.message || 'Failed to download file.'}` 
                    }, { quoted: task.msg });
                }
            } finally {
                activeAbortController = null;
                if (downloadQueue.length > 0 && downloadQueue[0] === task) {
                    downloadQueue.shift();
                }
            }
        }

        isProcessingQueue = false;
    }

    // Message Handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const textMessage = msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            msg.message.imageMessage?.caption ||
                            msg.message.videoMessage?.caption || '';

        if (!textMessage.startsWith(config.prefix)) return;

        const command = textMessage.slice(config.prefix.length).trim().split(' ')[0].toLowerCase();
        const args = textMessage.trim().split(/ +/).slice(1);

        // --- COMMAND 1: Direct File Download (.dlurlm <link>) ---
        if (command === 'dlurlm') {
            const url = args[0];

            if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ Usage:\n${config.prefix}dlurlm <Direct Link>\n\n💡 *Example:* \n${config.prefix}dlurlm https://example.com/file.pdf` 
                }, { quoted: msg });
                return;
            }

            await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });

            let tempName = url.split('/').pop().split('?')[0] || 'Unknown File';
            let fileSize = 'Unknown Size';

            // HEAD Request එකක් මගින් File Name එකයි Size එකයි කලින්ම ලබා ගැනීම
            try {
                const headRes = await axios.head(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    timeout: 5000
                });

                const length = headRes.headers['content-length'];
                if (length) fileSize = formatBytes(parseInt(length));

                const disposition = headRes.headers['content-disposition'];
                if (disposition && disposition.includes('filename=')) {
                    tempName = disposition.split('filename=')[1].replace(/["']/g, '').trim();
                }
            } catch (e) {
                // HEAD Request එක අසාර්ථක වුවහොත් default values භාවිතා වේ.
            }

            downloadQueue.push({
                url,
                from,
                msg,
                fileName: tempName,
                fileSize: fileSize,
                status: 'pending'
            });

            await sock.sendMessage(from, { react: { text: '📥', key: msg.key } });

            await sock.sendMessage(from, { 
                text: `📥 *Link Added to Queue*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n🔢 *Queue Position:* ${downloadQueue.length}` 
            }, { quoted: msg });

            processQueue();
        }

        // --- COMMAND 2: Check Download Queue (.qm) ---
        if (command === 'qm' || command === 'queue') {
            await sock.sendMessage(from, { react: { text: '📋', key: msg.key } });

            if (downloadQueue.length === 0) {
                await sock.sendMessage(from, { text: '📥 Queue is empty' }, { quoted: msg });
                return;
            }

            let queueText = `📋 *Download Queue List (${downloadQueue.length})*\n\n`;
            downloadQueue.forEach((item, index) => {
                const statusBadge = item.status === 'processing' ? '⚙️' : '⏳';
                queueText += `*${index + 1}.* ${statusBadge} *Name:* ${item.fileName}\n   📊 *Size:* ${item.fileSize || 'Unknown'}\n`;
            });

            await sock.sendMessage(from, { text: queueText.trim() }, { quoted: msg });
        }

        // --- COMMAND 3: Cancel Queue (.dqm) ---
        if (command === 'dqm' || command === 'cancelqueue') {
            await sock.sendMessage(from, { react: { text: '🛑', key: msg.key } });

            if (downloadQueue.length === 0 && !activeAbortController) {
                await sock.sendMessage(from, { text: 'ℹ️ Queue is already empty' }, { quoted: msg });
                return;
            }

            if (activeAbortController) {
                activeAbortController.abort();
            }

            downloadQueue.length = 0;

            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            await sock.sendMessage(from, { text: `🛑 Queue cleared and current download stopped.` }, { quoted: msg });
        }

        // --- COMMAND 4: Forwarding without Forwarded Tag (.fwm <JIDs>) ---
        if (command === 'fwm') {
            const rawTargets = args.join(' ').split(/[\s,]+/).filter(Boolean);

            if (rawTargets.length === 0) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ Usage:\nReply to a message and provide up to 3 JIDs/Numbers:\n💡 *Example:* ${config.prefix}fwm 94711111111 94722222222 1203xxxxxx@g.us`
                }, { quoted: msg });
                return;
            }

            const targets = rawTargets.slice(0, 3);
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
            const quotedMsg = contextInfo?.quotedMessage;

            if (!quotedMsg) {
                await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(from, { text: '⚠️ Please reply to the message or media you want to forward.' }, { quoted: msg });
                return;
            }

            await sock.sendMessage(from, { react: { text: '🔄', key: msg.key } });

            const successList = [];
            const failedList = [];

            for (let targetJid of targets) {
                try {
                    if (!targetJid.includes('@')) {
                        targetJid = `${targetJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                    }

                    const preparedMsg = generateWAMessageFromContent(targetJid, quotedMsg, {});
                    await sock.relayMessage(targetJid, preparedMsg.message, { messageId: preparedMsg.key.id });
                    
                    successList.push(targetJid);
                } catch (error) {
                    console.error(`Forward Error (${targetJid}):`, error.message);
                    failedList.push(targetJid);
                }
            }

            if (successList.length > 0) {
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                let resultMsg = `✅ *Successfully forwarded to ${successList.length} target(s):*\n` + successList.map(j => `📌 ${j}`).join('\n');
                if (failedList.length > 0) resultMsg += `\n\n❌ *Failed:* ${failedList.length}`;
                await sock.sendMessage(from, { text: resultMsg }, { quoted: msg });
            } else {
                await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(from, { text: '❌ Failed to forward to provided targets.' }, { quoted: msg });
            }
        }

        // --- COMMAND 5: JID Finder (.jid) ---
        if (command === 'jid') {
            await sock.sendMessage(from, { react: { text: '📌', key: msg.key } });
            await sock.sendMessage(from, { text: `📌 Current Chat JID:\n${from}` }, { quoted: msg });
        }

        // --- COMMAND 6: Platform & System Info (.platform / .sys / .host) ---
        if (command === 'platform' || command === 'sys' || command === 'host') {
            await sock.sendMessage(from, { react: { text: '🖥️', key: msg.key } });

            const platform = os.platform();
            let osName = platform;
            if (platform === 'win32') osName = 'Windows';
            else if (platform === 'linux') osName = 'Linux (Ubuntu/Debian/VPS)';
            else if (platform === 'darwin') osName = 'macOS';
            else if (platform === 'android') osName = 'Android (Termux)';

            const arch = os.arch();
            const totalMem = formatBytes(os.totalmem());
            const freeMem = formatBytes(os.freemem());
            const uptimeHours = (os.uptime() / 3600).toFixed(1);

            const sysInfo = `🖥️ *Bot Hosting Platform Info*\n\n` +
                            `💻 *OS Platform:* ${osName}\n` +
                            `⚙️ *Architecture:* ${arch}\n` +
                            `🟢 *Node.js Version:* ${process.version}\n` +
                            `💾 *RAM Usage:* ${freeMem} Free / ${totalMem} Total\n` +
                            `⏱️ *System Uptime:* ${uptimeHours} Hours`;

            await sock.sendMessage(from, { text: sysInfo }, { quoted: msg });
        }
    });
}

connectToWhatsApp();