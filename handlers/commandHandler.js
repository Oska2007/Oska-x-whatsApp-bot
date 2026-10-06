import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import os from 'os';
import config from '../config.js';
import { getFileMetaData, getMaxAllowedDownloadSize, formatBytes, getDetailedOS } from '../lib/utils.js';
import { downloadQueue, processQueue, isProcessingQueue } from '../lib/downloader.js';

export async function handleCommand(sock, msg, from, textMessage) {
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
            `📜 *${config.prefix}menu*\n` +
            `└ Display this command menu.`;

        await sock.sendMessage(from, { text: menuText }, { quoted: msg });
    }

    // --- COMMAND 2: Direct File Download (.dlurlm <link>) ---
    else if (command === 'dlurlm') {
        const url = args[0];

        if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
            await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `⚠️ Usage:\n${config.prefix}dlurlm <Direct Link>\n\n💡 *Example:* \n${config.prefix}dlurlm https://example.com/file.pdf` 
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(from, { react: { text: '🔍', key: msg.key } });

        const { fileName: tempName, fileSize, sizeInBytes } = await getFileMetaData(url);
        const { freeRamBytes, maxDownloadBytes } = getMaxAllowedDownloadSize();

        // FIX 3: Handling unknown size (sizeInBytes === 0)
        if (sizeInBytes === 0) {
            await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `⚠️ *Unknown File Size!*\n\n📄 *File Name:* ${tempName}\n\nThe file size could not be determined. Proceeding with caution, but it may fail if it exceeds limits.` 
            }, { quoted: msg });
        }

        // FIX 1: Add 2GB limit check for WhatsApp
        if (sizeInBytes > 2000000000) {
             await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
             await sock.sendMessage(from, { 
                text: `❌ *File Too Large for WhatsApp!*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n⚠️ *WhatsApp Limit:* 2 GB\n\n_Cannot send files larger than 2GB via WhatsApp._` 
            }, { quoted: msg });
            return;
        }

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

        // FIX 5: Handle Promise Rejection
        processQueue(sock).catch(console.error);
    }

    // --- COMMAND 3: Priority Queue (.qf <Number | Link>) ---
    else if (command === 'qf' || command === 'qfast') {
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

            // FIX 3: Handling unknown size (sizeInBytes === 0)
            if (sizeInBytes === 0) {
                await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                await sock.sendMessage(from, { 
                    text: `⚠️ *Unknown File Size!*\n\n📄 *File Name:* ${tempName}\n\nThe file size could not be determined. Proceeding with caution, but it may fail if it exceeds limits.` 
                }, { quoted: msg });
            }

            // FIX 1: Add 2GB limit check for WhatsApp
            if (sizeInBytes > 2000000000) {
                 await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                 await sock.sendMessage(from, { 
                    text: `❌ *File Too Large for WhatsApp!*\n\n📄 *File Name:* ${tempName}\n📊 *File Size:* ${fileSize}\n⚠️ *WhatsApp Limit:* 2 GB\n\n_Cannot send files larger than 2GB via WhatsApp._` 
                }, { quoted: msg });
                return;
            }

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

            // FIX 5: Handle Promise Rejection
            processQueue(sock).catch(console.error);
            return;
        }

        await sock.sendMessage(from, { text: `⚠️ Invalid input. Provide a queue number or a valid HTTP/HTTPS link.` }, { quoted: msg });
    }

    // --- COMMAND 4: Check Progress (.du) ---
    else if (command === 'du' || command === 'status' || command === 'progress') {
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

    // --- COMMAND 5: Check Queue (.qm) ---
    else if (command === 'qm' || command === 'queue') {
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
    else if (command === 'dqm' || command === 'cancelqueue') {
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

    // --- COMMAND 7: Forward without Tag (.fwm <JIDs>) ---
    else if (command === 'fwm') {
        const rawTargets = args.join(' ').split(/[\s,]+/).filter(Boolean);

        if (rawTargets.length === 0) {
            await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
            await sock.sendMessage(from, { 
                text: `⚠️ Usage:\nReply to a message and provide up to 6 JIDs/Numbers:\n💡 *Example:* ${config.prefix}fwm 94711111111 94722222222 1203xxxxxx@g.us`
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

    // --- COMMAND 9: Platform Info (.platform / .sys) ---
    else if (command === 'platform' || command === 'sys' || command === 'host') {
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
