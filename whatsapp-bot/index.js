import { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import axios from 'axios';
import mime from 'mime-types';
import { fileTypeFromBuffer } from 'file-type';
import config from './config.js';

// Global Download Queue & Controller
const downloadQueue = [];
let isProcessingQueue = false;
let activeAbortController = null; // Active request එක cancel කිරීම සඳහා

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

    // Connection Status පරික්ෂා කිරීම
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📌 පහත QR Code එක Scan කරන්න:\n');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[!] සම්බන්ධතාවය බිඳ වැටුණි (${statusCode}). නැවත සම්බන්ධ වෙමින්...`);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('[X] Session එක අවලංගු වී ඇත. "session" folder එක delete කර නැවත QR scan කරන්න.');
            }
        } else if (connection === 'open') {
            console.log('--------------------------------------------------');
            console.log(`✅ ${config.botName} සාර්ථකව WhatsApp වෙත සම්බන්ධ විය!`);
            console.log('--------------------------------------------------');
        }
    });

    // Queue එක එකින් එක Process කරන Function එක
    async function processQueue() {
        if (isProcessingQueue) return;
        isProcessingQueue = true;

        while (downloadQueue.length > 0) {
            const task = downloadQueue[0];
            task.status = 'processing';
            activeAbortController = new AbortController(); // අලුත් request එකකට AbortController එකක් සාදයි

            try {
                // React: ⏳ Download වෙමින් පවතී
                await sock.sendMessage(task.from, { react: { text: '⏳', key: task.msg.key } });

                // Browser Header සහ Signal එකක් සමඟ Download කිරීම
                const response = await axios.get(task.url, { 
                    responseType: 'arraybuffer',
                    signal: activeAbortController.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });

                const buffer = Buffer.from(response.data);

                // Buffer එක මගින් File Type එක හඳුනාගැනීම
                const detectedType = await fileTypeFromBuffer(buffer);
                let mimeType = detectedType?.mime || response.headers['content-type']?.split(';')[0] || 'application/octet-stream';
                let ext = detectedType?.ext || mime.extension(mimeType) || '';

                // File Name එක සකස් කිරීම
                let fileName = '';
                const disposition = response.headers['content-disposition'];

                if (disposition && disposition.includes('filename=')) {
                    fileName = disposition.split('filename=')[1].replace(/["']/g, '').trim();
                } else {
                    fileName = task.url.split('/').pop().split('?')[0] || 'downloaded_file';
                }

                if (!fileName.includes('.') || fileName.endsWith('.bin')) {
                    const baseName = fileName.replace(/\.bin$/, '');
                    fileName = ext ? `${baseName}.${ext}` : baseName;
                }

                task.fileName = fileName;

                // WhatsApp එකට Upload කිරීම
                await sock.sendMessage(task.from, {
                    document: buffer,
                    mimetype: mimeType,
                    fileName: fileName
                }, { quoted: task.msg });

                // React: ✅ සාර්ථකයි
                await sock.sendMessage(task.from, { react: { text: '✅', key: task.msg.key } });

            } catch (error) {
                // User විසින් Cancel කළ විට සිදුවන Error එක අල්ලා ගැනීම
                if (axios.isCancel(error) || error.name === 'CanceledError' || error.name === 'AbortError') {
                    console.log(`[Canceled] ${task.url}`);
                    await sock.sendMessage(task.from, { react: { text: '🛑', key: task.msg.key } });
                } else {
                    console.error(`DLURL Error (${task.url}):`, error.message);

                    // React: ❌ අසාර්ථකයි
                    await sock.sendMessage(task.from, { react: { text: '❌', key: task.msg.key } });
                    
                    // Error Message එක යැවීම
                    await sock.sendMessage(task.from, { 
                        text: `❌ *Download Error!*\n\n🔗 *Link:* ${task.url}\n⚠️ *Reason:* ${error.message || 'File එක download කිරීමට නොහැකි විය.'}` 
                    }, { quoted: task.msg });
                }
            } finally {
                activeAbortController = null;
                downloadQueue.shift(); // Process වූ හෝ Cancel වූ පසු Queue එකෙන් ඉවත් කරයි
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

        // --- COMMAND 1: Direct File Download (.dlurl <link>) ---
        if (command === 'dlurlm') {
            const url = args[0];

            if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ භාවිත කරන ආකාරය:\n${config.prefix}dlurl <Direct Link>\n\n💡 *උදාහරණය:* \n${config.prefix}dlurl https://example.com/file.pdf` 
                }, { quoted: msg });
                return;
            }

            await sock.sendMessage(from, { react: { text: '📥', key: msg.key } });

            const tempName = url.split('/').pop().split('?')[0] || 'Unknown File';
            
            downloadQueue.push({
                url,
                from,
                msg,
                fileName: tempName,
                status: 'pending'
            });

            await sock.sendMessage(from, { 
                text: `📥 Link added to download list\n🔢 Download number: ${downloadQueue.length}` 
            }, { quoted: msg });

            processQueue();
        }

        // --- COMMAND 2: Check Download Queue (.q) ---
        if (command === 'qm' || command === 'queue') {
            await sock.sendMessage(from, { react: { text: '📋', key: msg.key } });

            if (downloadQueue.length === 0) {
                await sock.sendMessage(from, { text: '📥 Empty' }, { quoted: msg });
                return;
            }

            let queueText = `📋 *Download Queue List (${downloadQueue.length})*\n\n`;
            downloadQueue.forEach((item, index) => {
                const statusBadge = item.status === 'processing' ? '⏳' : '⏳';
                queueText += `*${index + 1}.* ${statusBadge}\n📁 *File Name:* ${item.fileName}`;
            });

            await sock.sendMessage(from, { text: queueText.trim() }, { quoted: msg });
        }

        // --- COMMAND 3: Cancel All Downloads / Clear Queue (.dq) ---
        if (command === 'dqm' || command === 'cancelqueue') {
            await sock.sendMessage(from, { react: { text: '🛑', key: msg.key } });

            const totalInQueue = downloadQueue.length;

            if (totalInQueue === 0 && !activeAbortController) {
                await sock.sendMessage(from, { text: 'ℹ️ Successfully deleted' }, { quoted: msg });
                return;
            }

            // 1. Active Request එක අත්හිටුවීම
            if (activeAbortController) {
                activeAbortController.abort();
            }

            // 2. Queue එක හිස් කිරීම
            downloadQueue.length = 0;

            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `🛑 Successfully cancelled` 
            }, { quoted: msg });
        }

// --- COMMAND 4: Direct Forwarding without Forwarded Tag (Up to 3 Targets) (.fwm <JID1> <JID2> <JID3>) ---
if (command === 'fwm') {
    // ලබාදුන් සියලුම JIDs/Numbers වෙන් කරගැනීම (Space හෝ Comma මගින්)
    const rawTargets = args.join(' ').split(/[\s,]+/).filter(Boolean);

    if (rawTargets.length === 0) {
        await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
        await sock.sendMessage(from, { 
            text: `⚠️ භාවිත කරන ආකාරය:\nMessage එකකට Reply කරමින් JID/Numbers 3ක් දක්වා ලබාදෙන්න:\n💡 *උදා:* ${config.prefix}fwm 94711111111 94722222222 1203xxxxxx@g.us`
        }, { quoted: msg });
        return;
    }

    // උපරිම Target 3කට පමණක් සීමා කිරීම
    const targets = rawTargets.slice(0, 3);

    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = contextInfo?.quotedMessage;

    if (!quotedMsg) {
        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
        await sock.sendMessage(from, { text: '⚠️ Forward කිරීමට අවශ්‍ය Message/Media එකට Reply කරමින් කමාන්ඩ් එක ලබා දෙන්න.' }, { quoted: msg });
        return;
    }

    await sock.sendMessage(from, { react: { text: '🔄', key: msg.key } });

    const successList = [];
    const failedList = [];

    // JIDs එකින් එකට Forward කිරීම
    for (let targetJid of targets) {
        try {
            if (!targetJid.includes('@')) {
                targetJid = `${targetJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
            }

            // Raw Message එක Forwarded Tag එක නොමැතිව Send කිරීම
            await sock.relayMessage(targetJid, quotedMsg, {});
            successList.push(targetJid);
        } catch (error) {
            console.error(`Forward Error (${targetJid}):`, error.message);
            failedList.push(targetJid);
        }
    }

    // යැවූ පසු ලැබෙන Status Message එක
    if (successList.length > 0) {
        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
        let resultMsg = `✅ *Successfully sent to ${successList.length} target(s):*\n` + successList.map(j => `📌 ${j}`).join('\n');
        
        if (failedList.length > 0) {
            resultMsg += `\n\n❌ *Failed:* ${failedList.length}`;
        }

        await sock.sendMessage(from, { text: resultMsg }, { quoted: msg });
    } else {
        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
        await sock.sendMessage(from, { text: '❌ Sending error to all targets.' }, { quoted: msg });
    }
}
        // --- COMMAND 5: JID Finder (.jid) ---
        if (command === 'jid') {
            await sock.sendMessage(from, { react: { text: '📌', key: msg.key } });
            await sock.sendMessage(from, { text: `📌 Current Chat JID:\n${from}` }, { quoted: msg });
        }
    });
}

connectToWhatsApp();