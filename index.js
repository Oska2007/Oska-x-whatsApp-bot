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
import fs from 'fs';
import config from './config.js';

// Specific Target Group JID (Admin Crew Group) for Multi-Message Memory Storage
const TARGET_GROUP_JID = '120363041116265527@g.us';

// Global Download Queue & Controller
const downloadQueue = [];
let isProcessingQueue = false;
let activeAbortController = null;

// Global Memory Store for Multi-Forward History (RAM-only)
const msgStore = new Map();

// Helper: Format Bytes to Human Readable Size
function formatBytes(bytes, decimals = 2) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper: Get OS Info
function getDetailedOS() {
    const platform = os.platform();
    if (platform === 'win32') return 'Windows';
    if (platform === 'darwin') return 'macOS';
    
    if (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) {
        return 'Android (Termux)';
    }

    if (platform === 'linux') {
        let osName = 'Linux';
        try {
            if (fs.existsSync('/etc/os-release')) {
                const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
                const match = osRelease.match(/^PRETTY_NAME="(.*)"$/m) || osRelease.match(/^NAME="(.*)"$/m);
                if (match && match[1]) {
                    osName = match[1].replace(/["']/g, '');
                }
            }
        } catch (e) {
            osName = 'Linux (Generic)';
        }

        let cloudEnv = '';
        if (process.env.HEROKU_APP_ID || process.env.DYNO) cloudEnv = ' [Heroku]';
        else if (process.env.KOYEB_SERVICE_ID) cloudEnv = ' [Koyeb]';
        else if (process.env.RENDER_SERVICE_ID) cloudEnv = ' [Render]';
        else if (process.env.RAILWAY_SERVICE_ID) cloudEnv = ' [Railway]';
        else if (fs.existsSync('/.dockerenv')) cloudEnv = ' [Docker Container]';

        return `${osName}${cloudEnv}`;
    }

    return platform;
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    sock.ev.on('creds.update', saveCreds);

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
            console.log('⚠️ Please provide a valid phone number in config.js for pairing.');
        }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !config.usePairingCode) {
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
            console.log(`✅ ${config.botName || 'Bot'} connected successfully!`);
            console.log(`🎯 Admin Crew Group Jid: ${TARGET_GROUP_JID}`);
            console.log('--------------------------------------------------');
        }
    });

    // Queue Processor
    async function processQueue() {
        if (isProcessingQueue) return;
        isProcessingQueue = true;

        while (downloadQueue.length > 0) {
            const task = downloadQueue[0];
            task.status = 'downloading';
            task.downloadedBytes = 0;
            task.totalBytes = 0;
            task.startTime = Date.now();
            task.speed = 0;

            activeAbortController = new AbortController();

            try {
                await sock.sendMessage(task.from, { react: { text: '⏳', key: task.msg.key } });

                const response = await axios.get(task.url, { 
                    responseType: 'arraybuffer',
                    signal: activeAbortController.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    onDownloadProgress: (progressEvent) => {
                        task.downloadedBytes = progressEvent.loaded;
                        task.totalBytes = progressEvent.total || 0;
                        const timeElapsed = (Date.now() - task.startTime) / 1000;
                        if (timeElapsed > 0) {
                            task.speed = task.downloadedBytes / timeElapsed;
                        }
                    }
                });

                task.status = 'uploading';

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
                    console.error(`Download Error (${task.url}):`, error.message);
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

    // Message Upsert Listener
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // Store messages ONLY from Target Admin Crew Group (For multi-message forwarding)
        for (const m of messages) {
            if (!m.message) continue;
            const chatJid = m.key.remoteJid;

            if (chatJid !== TARGET_GROUP_JID) continue;

            if (!msgStore.has(chatJid)) {
                msgStore.set(chatJid, []);
            }
            const chatHistory = msgStore.get(chatJid);
            if (!chatHistory.some(existing => existing.key.id === m.key.id)) {
                chatHistory.push(m);
                if (chatHistory.length > 500) chatHistory.shift();
            }
        }

        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderNumber = sender.replace(/[^0-9]/g, '');

        const isAllowed = msg.key.fromMe || config.allowedUsers.some(num => senderNumber.includes(num.replace(/[^0-9]/g, '')));
        if (!isAllowed) return;

        const textMessage = msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            msg.message.imageMessage?.caption ||
                            msg.message.videoMessage?.caption || '';

        if (!textMessage.startsWith(config.prefix)) return;

        const commandStr = textMessage.slice(config.prefix.length).trim().split(' ')[0].toLowerCase();
        const args = textMessage.trim().split(/ +/).slice(1);

        // --- COMMAND 1: Menu ---
        if (commandStr === 'menu' || commandStr === 'help') {
            await sock.sendMessage(from, { react: { text: '📜', key: msg.key } });

            const menuText = 
                `🤖 *${config.botName || 'WhatsApp Bot'} Commands Menu*\n` +
                `PREFIX: \`${config.prefix}\`\n\n` +
                `📥 *DOWNLOAD COMMANDS*\n` +
                `🔹 *${config.prefix}dlurlm <Link>*\n` +
                `└ Download a file directly from a direct link.\n\n` +
                `⚡ *${config.prefix}qf <Queue No | Link>*\n` +
                `└ Move item to priority or add urgent link.\n\n` +
                `📊 *${config.prefix}du*\n` +
                `└ Check active download/upload status and progress.\n\n` +
                `📋 *${config.prefix}qm*\n` +
                `└ View full download queue.\n\n` +
                `🛑 *${config.prefix}dqm*\n` +
                `└ Stop current download and clear queue.\n\n` +
                `⚙️ *FORWARD COMMANDS*\n` +
                `🔹 *${config.prefix}fwm <Target JID/Phone>*\n` +
                `└ Forward single replied message (Works in ALL chats).\n\n` +
                `🔹 *${config.prefix}fwm[N] <Target JID/Phone>*\n` +
                `└ Forward N messages starting from replied msg (Admin Crew Group only).\n\n` +
                `📌 *${config.prefix}jid*\n` +
                `└ View current chat JID.\n\n` +
                `🖥️ *${config.prefix}platform*\n` +
                `└ View system specs and bot runtime.\n\n` +
                `📜 *${config.prefix}menu*\n` +
                `└ Display this menu.`;

            await sock.sendMessage(from, { text: menuText }, { quoted: msg });
        }

        // --- COMMAND 2: Direct Download ---
        if (commandStr === 'dlurlm') {
            const url = args[0];

            if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ *Usage:* \`${config.prefix}dlurlm <Direct Link>\`\n\n💡 *Example:* \`${config.prefix}dlurlm https://example.com/file.pdf\`` 
                }, { quoted: msg });
                return;
            }

            await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });

            let tempName = url.split('/').pop().split('?')[0] || 'Unknown File';
            let fileSize = 'Unknown Size';

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
            } catch (e) {}

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
                text: `📥 *Link Added to Queue*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n🔢 *Queue Position:* #${downloadQueue.length}` 
            }, { quoted: msg });

            processQueue();
        }

        // --- COMMAND 3: Priority Download ---
        if (commandStr === 'qf' || commandStr === 'qfast') {
            const input = args[0];

            if (!input) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ *Usage Options:*\n\n1️⃣ *Move Queue Item:* \`${config.prefix}qf <Queue Number>\`\n2️⃣ *Priority Link:* \`${config.prefix}qf <Direct Link>\`` 
                }, { quoted: msg });
                return;
            }

            if (!isNaN(input)) {
                const queueNum = parseInt(input);
                const indexToMove = queueNum - 1;

                if (queueNum <= 1 || indexToMove >= downloadQueue.length) {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(from, { 
                        text: `❌ Invalid queue number! Enter a number between 2 and ${downloadQueue.length}.` 
                    }, { quoted: msg });
                    return;
                }

                const [movedTask] = downloadQueue.splice(indexToMove, 1);
                const insertPos = isProcessingQueue ? 1 : 0;
                downloadQueue.splice(insertPos, 0, movedTask);

                await sock.sendMessage(from, { react: { text: '⚡', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚡ *Moved to Priority!*\n\n📄 *File Name:* ${movedTask.fileName}\n📌 New Position: Next in Line (#${insertPos + 1})` 
                }, { quoted: msg });
                return;
            }

            if (input.startsWith('http://') || input.startsWith('https://')) {
                const url = input;
                await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });

                let tempName = url.split('/').pop().split('?')[0] || 'Unknown File';
                let fileSize = 'Unknown Size';

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
                } catch (e) {}

                const priorityTask = {
                    url,
                    from,
                    msg,
                    fileName: tempName,
                    fileSize: fileSize,
                    status: 'pending'
                };

                const insertPos = isProcessingQueue ? 1 : 0;
                downloadQueue.splice(insertPos, 0, priorityTask);

                await sock.sendMessage(from, { react: { text: '⚡', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚡ *Priority Link Added!*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n📌 *Queue Position:* Next in Line (#${insertPos + 1})` 
                }, { quoted: msg });

                processQueue();
                return;
            }

            await sock.sendMessage(from, { text: `⚠️ Invalid input. Provide a queue number or a valid link.` }, { quoted: msg });
        }

        // --- COMMAND 4: Download Status ---
        if (commandStr === 'du' || commandStr === 'status' || commandStr === 'progress') {
            await sock.sendMessage(from, { react: { text: '📊', key: msg.key } });

            const activeTask = downloadQueue.find(t => t.status === 'downloading' || t.status === 'uploading');

            if (!activeTask) {
                await sock.sendMessage(from, { text: 'ℹ️ No active download or upload process currently running.' }, { quoted: msg });
                return;
            }

            let statusMsg = `📊 *Active Task Status*\n\n`;
            statusMsg += `📄 *File Name:* ${activeTask.fileName}\n`;

            if (activeTask.status === 'downloading') {
                const downloaded = activeTask.downloadedBytes || 0;
                const total = activeTask.totalBytes || 0;
                const percent = total > 0 ? ((downloaded / total) * 100).toFixed(1) : 'N/A';
                const speed = activeTask.speed || 0;

                let eta = 'Calculating...';
                if (total > 0 && speed > 0 && downloaded < total) {
                    const remainingBytes = total - downloaded;
                    const remainingSeconds = Math.ceil(remainingBytes / speed);
                    eta = remainingSeconds > 60 
                        ? `${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s` 
                        : `${remainingSeconds}s`;
                }

                statusMsg += `🔄 *Status:* Downloading 📥\n`;
                statusMsg += `📥 *Downloaded:* ${formatBytes(downloaded)} / ${total > 0 ? formatBytes(total) : 'Unknown'}\n`;
                statusMsg += `📈 *Progress:* ${percent}%\n`;
                statusMsg += `⚡ *Speed:* ${formatBytes(speed)}/s\n`;
                statusMsg += `⏳ *ETA:* ${eta}`;

            } else if (activeTask.status === 'uploading') {
                statusMsg += `🔄 *Status:* Uploading to WhatsApp 📤\n`;
                statusMsg += `⏳ File downloaded successfully. Sending media to chat...`;
            }

            await sock.sendMessage(from, { text: statusMsg }, { quoted: msg });
        }

        // --- COMMAND 5: View Queue ---
        if (commandStr === 'qm' || commandStr === 'queue') {
            await sock.sendMessage(from, { react: { text: '📋', key: msg.key } });

            if (downloadQueue.length === 0) {
                await sock.sendMessage(from, { text: '📥 Download queue is currently empty.' }, { quoted: msg });
                return;
            }

            let queueText = `📋 *Download Queue (${downloadQueue.length})*\n\n`;
            downloadQueue.forEach((item, index) => {
                const statusBadge = item.status === 'downloading' ? '⚙️' : item.status === 'uploading' ? '📤' : '⏳';
                queueText += `*${index + 1}.* ${statusBadge} *Name:* ${item.fileName}\n   📊 *Size:* ${item.fileSize || 'Unknown'}\n`;
            });

            await sock.sendMessage(from, { text: queueText.trim() }, { quoted: msg });
        }

        // --- COMMAND 6: Clear Queue ---
        if (commandStr === 'dqm' || commandStr === 'cancelqueue') {
            await sock.sendMessage(from, { react: { text: '🛑', key: msg.key } });

            if (downloadQueue.length === 0 && !activeAbortController) {
                await sock.sendMessage(from, { text: 'ℹ️ Queue is already empty.' }, { quoted: msg });
                return;
            }

            if (activeAbortController) {
                activeAbortController.abort();
            }

            downloadQueue.length = 0;

            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
            await sock.sendMessage(from, { text: `🛑 Active download stopped and queue cleared.` }, { quoted: msg });
        }

        // --- COMMAND 7: Dynamic Forwarding (.fwm / .fwm10 / .fwm<N>) ---
        if (commandStr.startsWith('fwm')) {
            let forwardCount = 1;

            const numInCmd = commandStr.replace('fwm', '');
            if (numInCmd && !isNaN(numInCmd)) {
                forwardCount = parseInt(numInCmd);
            } else if (args.length > 0 && !isNaN(args[0]) && !args[0].includes('@')) {
                forwardCount = parseInt(args.shift());
            }

            const rawTargets = args.join(' ').split(/[\s,]+/).filter(Boolean);

            if (rawTargets.length === 0) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ *Usage:*\n\n` +
                          `1️⃣ Single Forward (Any Chat):\n\`${config.prefix}fwm <Target JID/Phone>\`\n\n` +
                          `2️⃣ Multi Forward (Admin Crew Group Only):\n\`${config.prefix}fwm10 <Target JID/Phone>\``
                }, { quoted: msg });
                return;
            }

            const contextInfo = msg.message?.extendedTextMessage?.contextInfo ||
                              msg.message?.imageMessage?.contextInfo ||
                              msg.message?.videoMessage?.contextInfo ||
                              msg.message?.documentMessage?.contextInfo ||
                              msg.message?.audioMessage?.contextInfo ||
                              msg.message?.stickerMessage?.contextInfo;
                              
            const quotedMsg = contextInfo?.quotedMessage;
            const quotedStanzaId = contextInfo?.stanzaId;

            if (!quotedStanzaId) {
                await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(from, { text: '⚠️ Please reply to the message you want to forward.' }, { quoted: msg });
                return;
            }

            const targets = rawTargets.slice(0, 5);

            // ==========================================
            // OPTION A: Single Message Forwarding (NO MEMORY NEEDED)
            // ==========================================
            if (forwardCount === 1) {
                if (!quotedMsg) {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(from, { text: '❌ Could not retrieve replied message content.' }, { quoted: msg });
                    return;
                }

                await sock.sendMessage(from, { react: { text: '🔄', key: msg.key } });
                let successCount = 0;

                for (let targetJid of targets) {
                    if (!targetJid.includes('@')) {
                        targetJid = `${targetJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                    }

                    try {
                        const preparedMsg = generateWAMessageFromContent(targetJid, quotedMsg, {});
                        await sock.relayMessage(targetJid, preparedMsg.message, { messageId: preparedMsg.key.id });
                        successCount++;
                    } catch (error) {
                        console.error(`Single Forward Error (${targetJid}):`, error.message);
                    }
                }

                if (successCount > 0) {
                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } else {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                }
                return;
            }

            // ==========================================
            // OPTION B: Multi-Message Forwarding (RESTRICTED TO ADMIN CREW GROUP)
            // ==========================================
            
            // Check 1: Restricted Group Check
            if (from !== TARGET_GROUP_JID) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ *This cmd only works in the admin crew group.*` 
                }, { quoted: msg });
                return;
            }

            // Check 2: Out of Memory Check
            const history = msgStore.get(from) || [];
            const startIndex = history.findIndex(m => m.key.id === quotedStanzaId);

            if (startIndex === -1) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ *Messages are Out of Memory!*\n\nThese messages were sent before the bot went online or have expired from memory store.` 
                }, { quoted: msg });
                return;
            }

            const rawSlice = history.slice(startIndex);
            const validMessages = rawSlice.filter(m => {
                if (!m.message) return false;
                const keys = Object.keys(m.message);
                return !keys.includes('protocolMessage') && !keys.includes('reactionMessage') && !keys.includes('senderKeyDistributionMessage');
            });

            const messagesToForward = validMessages.slice(0, forwardCount);

            if (messagesToForward.length === 0) {
                await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(from, { text: '❌ No valid messages found to forward.' }, { quoted: msg });
                return;
            }

            await sock.sendMessage(from, { react: { text: '🔄', key: msg.key } });
            let totalSentCount = 0;

            for (let targetJid of targets) {
                if (!targetJid.includes('@')) {
                    targetJid = `${targetJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                }

                for (const item of messagesToForward) {
                    try {
                        const msgContent = item.message;
                        const preparedMsg = generateWAMessageFromContent(targetJid, msgContent, {});
                        await sock.relayMessage(targetJid, preparedMsg.message, { messageId: preparedMsg.key.id });
                        totalSentCount++;
                        
                        await new Promise(res => setTimeout(res, 400));
                    } catch (error) {
                        console.error(`Multi Forward Error (${targetJid}):`, error.message);
                    }
                }
            }

            if (totalSentCount > 0) {
                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `✅ *Successfully forwarded ${messagesToForward.length} message(s) to target!*` 
                }, { quoted: msg });
            } else {
                await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(from, { text: '❌ Failed to forward messages.' }, { quoted: msg });
            }
        }

        // --- COMMAND 8: JID Finder ---
        if (commandStr === 'jid') {
            await sock.sendMessage(from, { react: { text: '📌', key: msg.key } });
            await sock.sendMessage(from, { text: `📌 *Current Chat JID:*\n\`${from}\`` }, { quoted: msg });
        }

        // --- COMMAND 9: Platform Details ---
        if (commandStr === 'platform' || commandStr === 'sys' || commandStr === 'host') {
            await sock.sendMessage(from, { react: { text: '🖥️', key: msg.key } });

            const osName = getDetailedOS();
            const arch = os.arch();
            const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';
            
            const ramUsedByBot = formatBytes(process.memoryUsage().rss);
            const totalSysRam = formatBytes(os.totalmem());
            
            const botUptimeSeconds = Math.floor(process.uptime());
            const days = Math.floor(botUptimeSeconds / (3600 * 24));
            const hours = Math.floor((botUptimeSeconds % (3600 * 24)) / 3600);
            const minutes = Math.floor((botUptimeSeconds % 3600) / 60);
            const seconds = botUptimeSeconds % 60;
            
            let uptimeFormatted = '';
            if (days > 0) uptimeFormatted += `${days}d `;
            if (hours > 0) uptimeFormatted += `${hours}h `;
            if (minutes > 0) uptimeFormatted += `${minutes}m `;
            uptimeFormatted += `${seconds}s`;

            const sysInfo = `🖥️ *Bot System Info*\n\n` +
                            `💻 *OS Platform:* ${osName}\n` +
                            `⚙️ *Architecture:* ${arch}\n` +
                            `🧠 *CPU:* ${cpuModel}\n` +
                            `🟢 *Node.js Version:* ${process.version}\n` +
                            `💾 *RAM Usage:* ${ramUsedByBot} (Server Total: ${totalSysRam})\n` +
                            `⏱️ *Uptime:* ${uptimeFormatted}`;

            await sock.sendMessage(from, { text: sysInfo }, { quoted: msg });
        }
    });
}

connectToWhatsApp();