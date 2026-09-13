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

// Global Download Queue & Controller
const downloadQueue = [];
let isProcessingQueue = false;
let activeAbortController = null;

// Helper: Format Bytes to Human Readable Size
function formatBytes(bytes, decimals = 2) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper: Get Detailed OS & Hosting Environment Info
function getDetailedOS() {
    const platform = os.platform();

    if (platform === 'win32') return 'Windows';
    if (platform === 'darwin') return 'macOS';
    
    // Android / Termux පරීක්ෂාව
    if (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) {
        return 'Android (Termux)';
    }

    if (platform === 'linux') {
        let osName = 'Linux';

        // Linux Distribution එක /etc/os-release එකෙන් කියවීම
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

        // Host කරන Cloud Environment එක හඳුනාගැනීම
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

    // Pairing Code එක හරහා සම්බන්ධ වීම
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
            console.log('⚠️ Pairing Code එක ලබා ගැනීමට config.js හි සැබෑ දුරකථන අංකයක් යොදන්න.');
        }
    }

    // Connection Status
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
                console.log('[X] Session logged out. Delete "session" folder and re-scan QR code or re-pair code.');
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
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderNumber = sender.replace(/[^0-9]/g, '');

        const isAllowed = msg.key.fromMe || config.allowedUsers.some(num => senderNumber.includes(num.replace(/[^0-9]/g, '')));
        
        if (!isAllowed) return;

        const textMessage = msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            msg.message.imageMessage?.caption ||
                            msg.message.videoMessage?.caption || '';

        if (!textMessage.startsWith(config.prefix)) return;

        const command = textMessage.slice(config.prefix.length).trim().split(' ')[0].toLowerCase();
        const args = textMessage.trim().split(/ +/).slice(1);

        // --- COMMAND 1: Help Menu (.menu / .help) ---
        if (command === 'menu' || command === 'help') {
            await sock.sendMessage(from, { react: { text: '📜', key: msg.key } });

            const menuText = 
                `🤖 *${config.botName || 'WhatsApp Bot'} Commands Menu*\n` +
                `PREFIX: \`${config.prefix}\`\n\n` +
                `📥 *DOWNLOAD COMMANDS*\n` +
                `🔹 *${config.prefix}dlurlm <Link>*\n` +
                `└ Download a file directly from a direct link.\n\n` +
                `⚡ *${config.prefix}qf <Queue No | Link>*\n` +
                `└ Move a queue item to top or add an urgent direct link next in line.\n\n` +
                `📊 *${config.prefix}du*\n` +
                `└ Check real-time download/upload progress, speed, and ETA.\n\n` +
                `📋 *${config.prefix}qm*\n` +
                `└ View the complete list of files in the download queue.\n\n` +
                `🛑 *${config.prefix}dqm*\n` +
                `└ Stop active download and clear the entire queue.\n\n` +
                `⚙️ *UTILITY COMMANDS*\n` +
                `🔹 *${config.prefix}fwm <JID/Phone>*\n` +
                `└ Forward a replied message without the "Forwarded" tag.\n\n` +
                `📌 *${config.prefix}jid*\n` +
                `└ View the current chat JID address.\n\n` +
                `🖥️ *${config.prefix}platform*\n` +
                `└ View hosting platform OS, RAM usage, CPU, and Node.js details.\n\n` +
                `🔄 *${config.prefix}restart*\n` +
                `└ Restart the bot remotely.\n\n` +
                `📜 *${config.prefix}menu*\n` +
                `└ Display this command menu.`;

            await sock.sendMessage(from, { text: menuText }, { quoted: msg });
        }

        // --- COMMAND 2: Direct File Download (.dlurlm <link>) ---
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
                text: `📥 *Link Added to Queue*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n🔢 *Queue Position:* ${downloadQueue.length}` 
            }, { quoted: msg });

            processQueue();
        }

        // --- COMMAND 3: Priority Queue / Jump Queue (.qf <Number | Link>) ---
        if (command === 'qf' || command === 'qfast') {
            const input = args[0];

            if (!input) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ *Usage Options:*\n\n1️⃣ *Move Existing Item to Front:*\n${config.prefix}qf <Queue Number>\n💡 Example: \`${config.prefix}qf 3\`\n\n2️⃣ *Add Priority Link Immediately:*\n${config.prefix}qf <Direct Link>\n💡 Example: \`${config.prefix}qf https://example.com/file.zip\`` 
                }, { quoted: msg });
                return;
            }

            if (!isNaN(input)) {
                const queueNum = parseInt(input);
                const indexToMove = queueNum - 1;

                if (queueNum <= 1 || indexToMove >= downloadQueue.length) {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(from, { 
                        text: `❌ Invalid queue number! Please provide a number between 2 and ${downloadQueue.length}.` 
                    }, { quoted: msg });
                    return;
                }

                const [movedTask] = downloadQueue.splice(indexToMove, 1);
                const insertPos = isProcessingQueue ? 1 : 0;
                downloadQueue.splice(insertPos, 0, movedTask);

                await sock.sendMessage(from, { react: { text: '⚡', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚡ *Moved to Priority!*\n\n📄 *File Name:* ${movedTask.fileName}\n📌 Position changed to Next in Line (#${insertPos + 1})` 
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
                    text: `⚡ *Priority Link Added!*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n📌 *Queue Position:* Next in line (#${insertPos + 1})` 
                }, { quoted: msg });

                processQueue();
                return;
            }

            await sock.sendMessage(from, { text: `⚠️ Invalid input. Provide a queue number or a valid HTTP/HTTPS link.` }, { quoted: msg });
        }

        // --- COMMAND 4: Check Active Download Progress (.du) ---
        if (command === 'du' || command === 'status' || command === 'progress') {
            await sock.sendMessage(from, { react: { text: '📊', key: msg.key } });

            const activeTask = downloadQueue.find(t => t.status === 'downloading' || t.status === 'uploading');

            if (!activeTask) {
                await sock.sendMessage(from, { text: 'ℹ️ No active download or upload process running right now.' }, { quoted: msg });
                return;
            }

            let statusMsg = `📊 *Active Process Status*\n\n`;
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

                statusMsg += `🔄 *Status:* Downloading from Link 📥\n`;
                statusMsg += `📥 *Downloaded:* ${formatBytes(downloaded)} / ${total > 0 ? formatBytes(total) : 'Unknown'}\n`;
                statusMsg += `📈 *Progress:* ${percent}%\n`;
                statusMsg += `⚡ *Speed:* ${formatBytes(speed)}/s\n`;
                statusMsg += `⏳ *ETA (Remaining Time):* ${eta}`;

            } else if (activeTask.status === 'uploading') {
                statusMsg += `🔄 *Status:* Uploading to WhatsApp 📤\n`;
                statusMsg += `⏳ File downloaded successfully. Sending media to chat...`;
            }

            await sock.sendMessage(from, { text: statusMsg }, { quoted: msg });
        }

        // --- COMMAND 5: Check Download Queue (.qm) ---
        if (command === 'qm' || command === 'queue') {
            await sock.sendMessage(from, { react: { text: '📋', key: msg.key } });

            if (downloadQueue.length === 0) {
                await sock.sendMessage(from, { text: '📥 Queue is empty' }, { quoted: msg });
                return;
            }

            let queueText = `📋 *Download Queue List (${downloadQueue.length})*\n\n`;
            downloadQueue.forEach((item, index) => {
                const statusBadge = item.status === 'downloading' ? '⚙️' : item.status === 'uploading' ? '📤' : '⏳';
                queueText += `*${index + 1}.* ${statusBadge} *Name:* ${item.fileName}\n   📊 *Size:* ${item.fileSize || 'Unknown'}\n`;
            });

            await sock.sendMessage(from, { text: queueText.trim() }, { quoted: msg });
        }

        // --- COMMAND 6: Cancel Queue (.dqm) ---
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

        // --- COMMAND 7: Forwarding without Forwarded Tag (.fwm <JIDs>) ---
        if (command === 'fwm') {
            const rawTargets = args.join(' ').split(/[\s,]+/).filter(Boolean);

            if (rawTargets.length === 0) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ Usage:\nReply to a message and provide up to 3 JIDs/Numbers:\n💡 *Example:* ${config.prefix}fwm 94711111111 94722222222 1203xxxxxx@g.us`
                }, { quoted: msg });
                return;
            }

            const targets = rawTargets.slice(0, 6);
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

        // --- COMMAND 8: JID Finder (.jid) ---
        if (command === 'jid') {
            await sock.sendMessage(from, { react: { text: '📌', key: msg.key } });
            await sock.sendMessage(from, { text: `📌 Current Chat JID:\n${from}` }, { quoted: msg });
        }

        // --- COMMAND 9: Platform & System Info (.platform / .sys) ---
        if (command === 'platform' || command === 'sys' || command === 'host') {
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

            const sysInfo = `🖥️ *Bot & System Performance Info*\n\n` +
                            `💻 *OS Platform:* ${osName}\n` +
                            `⚙️ *Architecture:* ${arch}\n` +
                            `🧠 *CPU:* ${cpuModel}\n` +
                            `🟢 *Node.js Version:* ${process.version}\n` +
                            `💾 *Bot RAM Usage:* ${ramUsedByBot} (Server Total: ${totalSysRam})\n` +
                            `⏱️ *Bot Runtime:* ${uptimeFormatted}`;

            await sock.sendMessage(from, { text: sysInfo }, { quoted: msg });
        }

        // --- COMMAND 10: Remote Bot Restart (.restart / .reboot) ---
        if (command === 'restart' || command === 'reboot') {
            await sock.sendMessage(from, { react: { text: '🔄', key: msg.key } });
            await sock.sendMessage(from, { text: `🔄 *Restarting Bot...*\n\n⏳ Please wait a few seconds while the bot reboots.` }, { quoted: msg });

            setTimeout(() => {
                process.exit(0);
            }, 1000);
        }
    });
}

connectToWhatsApp();