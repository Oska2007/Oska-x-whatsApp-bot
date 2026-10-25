import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import os from 'os';
import config from '../config.js';
import { getFileMetaData, getMaxAllowedDownloadSize, formatBytes, getDetailedOS } from '../lib/utils.js';
import { downloadQueue, processQueue, isProcessingQueue } from '../lib/downloader.js';

export async function handleCommand(sock, msg, from, textMessage) {
    const command = textMessage.slice(config.prefix.length).trim().split(' ')[0].toLowerCase();
    const args = textMessage.trim().split(/ +/).slice(1);

    // --- COMMAND 1: Help Menu (.menu) ---
    if (command === 'menu') {
        await sock.sendMessage(from, { react: { text: '📜', key: msg.key } });

        const menuText = 
            `🤖 *${config.botName || 'WhatsApp Bot'} Commands Menu*\n` +
            `PREFIX: \`${config.prefix}\`\n\n` +
            `📥 *DOWNLOAD COMMANDS*\n` +
            `🔹 *${config.prefix}dl <Link>*\n` +
            `└ Download a file directly from a direct link.\n\n` +
            `⚡ *${config.prefix}qf <Queue No | Link>*\n` +
            `└ Move a queue item to top or add an urgent direct link next in line.\n\n` +
            `📊 *${config.prefix}du*\n` +
            `└ Check real-time download/upload progress, speed, and ETA.\n\n` +
            `📋 *${config.prefix}q*\n` +
            `└ View the complete list of files in the download queue.\n\n` +
            `🛑 *${config.prefix}dq*\n` +
            `└ Stop active download and clear the entire queue.\n\n` +
            `⚙️ *UTILITY COMMANDS*\n` +
            `🔹 *${config.prefix}fw <JID/Phone>*\n` +
            `└ Forward a replied message without the "Forwarded" tag.\n\n` +
            `📌 *${config.prefix}jid*\n` +
            `└ View the current chat JID address.\n\n` +
            `🖥️ *${config.prefix}sys*\n` +
            `└ View hosting platform OS, RAM usage, CPU, and Node.js details.\n\n` +
            `📜 *${config.prefix}menu*\n` +
            `└ Display this command menu.`;

        await sock.sendMessage(from, { text: menuText }, { quoted: msg });
    }

    // --- COMMAND 2: Direct File Download (.dl <link>) ---
    else if (command === 'dl') {
        const url = args[0];

        if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
            await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `⚠️ Usage:\n${config.prefix}dl <Direct Link>\n\n💡 *Example:* \n${config.prefix}dl https://example.com/file.pdf` 
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });

        const { fileName: tempName, fileSize, sizeInBytes } = await getFileMetaData(url);
        const { freeRamBytes, maxDownloadBytes } = getMaxAllowedDownloadSize();

        if (sizeInBytes > 0 && sizeInBytes > maxDownloadBytes) {
            await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `❌ *File Size Exceeds Free RAM!*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n🧠 *Current Free RAM:* ${formatBytes(freeRamBytes)}\n⚠️ *Safe Download Limit:* ${formatBytes(maxDownloadBytes)}\n\n_This file was automatically blocked to prevent server Out of Memory and bot crash._` 
            }, { quoted: msg });
            return;
        }

        downloadQueue.push({
            url,
            from,
            msg,
            fileName: tempName,
            fileSize: fileSize,
            sizeInBytes: sizeInBytes,
            status: 'pending'
        });

        await sock.sendMessage(from, { react: { text: '📥', key: msg.key } });

        await sock.sendMessage(from, { 
            text: `📥 *Link Added to Queue*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n🔢 *Queue Position:* ${downloadQueue.length}` 
        }, { quoted: msg });

        processQueue(sock);
    }

    // --- COMMAND 3: Priority Queue (.qf <Number | Link>) ---
    else if (command === 'qf') {
        const input = args[0];

        if (!input) {
            await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `⚠️ *Usage Options:*\n\n1️⃣ *Move Existing Item to Front:*\n${config.prefix}qf <Queue Number>\n💡 Example: \`${config.prefix}qf 3\`\n\n2️⃣ *Add Priority Link Immediately:*\n${config.prefix}qf <Direct Link>\n💡 Example: \`${config.prefix}qf https://example.com/file.zip\`` 
            }, { quoted: msg });
            return;
        }

        if (!isNaN(input)) {
            const queueNum = parseInt(input, 10);
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

            const { fileName: tempName, fileSize, sizeInBytes } = await getFileMetaData(url);
            const { freeRamBytes, maxDownloadBytes } = getMaxAllowedDownloadSize();

            if (sizeInBytes > 0 && sizeInBytes > maxDownloadBytes) {
                await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `❌ *File Size Exceeds Free RAM!*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n🧠 *Current Free RAM:* ${formatBytes(freeRamBytes)}\n⚠️ *Safe Download Limit:* ${formatBytes(maxDownloadBytes)}\n\n_This file was automatically blocked to prevent server Out of Memory and bot crash._` 
                }, { quoted: msg });
                return;
            }

            const priorityTask = {
                url,
                from,
                msg,
                fileName: tempName,
                fileSize: fileSize,
                sizeInBytes: sizeInBytes,
                status: 'pending'
            };

            const insertPos = isProcessingQueue ? 1 : 0;
            downloadQueue.splice(insertPos, 0, priorityTask);

            await sock.sendMessage(from, { react: { text: '⚡', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `⚡ *Priority Link Added!*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n📌 *Queue Position:* Next in line (#${insertPos + 1})` 
            }, { quoted: msg });

            processQueue(sock);
            return;
        }

        await sock.sendMessage(from, { text: `⚠️ Invalid input. Provide a queue number or a valid HTTP/HTTPS link.` }, { quoted: msg });
    }

    // --- COMMAND 4: Check Progress (.du) ---
    else if (command === 'du') {
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

    // --- COMMAND 5: Check Queue (.q) ---
    else if (command === 'q') {
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

    // --- COMMAND 6: Cancel Queue (.dq) ---
    else if (command === 'dq') {
        await sock.sendMessage(from, { react: { text: '🛑', key: msg.key } });

        if (downloadQueue.length === 0) {
            await sock.sendMessage(from, { text: 'ℹ️ Queue is already empty' }, { quoted: msg });
            return;
        }

        downloadQueue.forEach(task => {
            if (task.abortController) {
                task.abortController.abort();
            }
        });

        downloadQueue.length = 0;

        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
        await sock.sendMessage(from, { text: `🛑 Queue cleared and active downloads cancelled.` }, { quoted: msg });
    }

    // --- COMMAND 7: Forward without Tag (.fw <JIDs>) ---
    else if (command === 'fw') {
        const rawTargets = args.join(' ').split(/[\s,]+/).filter(Boolean);

        if (rawTargets.length === 0) {
            await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `⚠️ Usage:\nReply to a message and provide up to 6 JIDs/Numbers:\n💡 *Example:* ${config.prefix}fw 94711111111 94722222222 1203xxxxxx@g.us`
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

        let hasSuccess = false;

        for (let targetJid of targets) {
            try {
                if (!targetJid.includes('@')) {
                    targetJid = `${targetJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
                }

                const preparedMsg = generateWAMessageFromContent(targetJid, quotedMsg, {});
                await sock.relayMessage(targetJid, preparedMsg.message, { messageId: preparedMsg.key.id });
                
                hasSuccess = true;
            } catch (error) {
                console.error(`Forward Error (${targetJid}):`, error.message);
            }
        }

        if (hasSuccess) {
            await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
        } else {
            await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
        }
    }

    // --- COMMAND 8: JID Finder (.jid) ---
    else if (command === 'jid') {
        await sock.sendMessage(from, { react: { text: '📌', key: msg.key } });
        await sock.sendMessage(from, { text: `📌 Current Chat JID:\n${from}` }, { quoted: msg });
    }

    // --- COMMAND 9: Platform Info (.sys) ---
    else if (command === 'sys') {
        await sock.sendMessage(from, { react: { text: '🖥', key: msg.key } });

        const osName = getDetailedOS();
        const arch = os.arch();
        const cpuModel = os.cpus()[0]?.model || 'Unknown CPU';
        
        const ramUsedByBot = formatBytes(process.memoryUsage().rss);
        const freeRamSys = formatBytes(os.freemem());
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

        const sysInfo = `🖥 *Bot & System Performance Info*\n\n` +
                        `💻 *OS Platform:* ${osName}\n` +
                        `⚙️ *Architecture:* ${arch}\n` +
                        `🧠 *CPU:* ${cpuModel}\n` +
                        `🟢 *Node.js Version:* ${process.version}\n` +
                        `💾 *Bot RAM Usage:* ${ramUsedByBot}\n` +
                        `🧠 *Free Server RAM:* ${freeRamSys} / Total: ${totalSysRam}\n` +
                        `⏱️ *Bot Runtime:* ${uptimeFormatted}`;

        await sock.sendMessage(from, { text: sysInfo }, { quoted: msg });
    }
}
